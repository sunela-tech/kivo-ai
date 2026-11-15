# INKOS Cloud

INKOS on Cloudflare Workers, with sign-in and billing by Clerk.

**Live (development instance):** https://inkos.playcore.workers.dev

![The Plans tab of the live site, with Clerk's pricing table](../docs/cloud-plans.png)

## How it works

| Part | Where it runs | What it does |
| --- | --- | --- |
| Page and drawing engine | the user's browser | INKOS 1 and INKOS 1.1, ported from PyTorch to JavaScript (`public/engine/`), run in a Web Worker and write 1-bit or six-colour PNGs |
| Pro engine | the user's browser | INKOS 1 Pro and INKOS 1.1 Pro as ONNX graphs (`pro_onnx.py`), run by onnxruntime-web on WebGPU, or WebAssembly without a GPU (`public/engine/pro.js`) |
| Worker (`src/worker.js`) | Cloudflare Workers | serves the page, verifies Clerk session tokens, applies the plan, counts images, stores the gallery, hands out weights |
| D1 database `inkos` | Cloudflare | daily image counts, projects, gallery PNGs |
| KV namespace `inkos-weights` | Cloudflare | INKOS 1 and 1.1 weights (13.3 MB each), the Pro graphs (about 116 MB per model, stored in 20 MiB parts) and onnxruntime-web 1.31.1 |
| Clerk application `INKOS` | Clerk | sign-in, user button, Clerk Billing plans and checkout |

The models run on the user's device because the Workers free plan allows
about 10 ms of CPU per request, far too little to run a neural network. An
INKOS 1 picture takes about one second on a laptop.

The Pro models are 57.6 million parameter diffusion models. Each is three
ONNX graphs: the text encoder, one guided denoising step, and the 2x
refiner. Weights are stored as float16 and computed in float32. The page
downloads them once, checks their SHA-256 and keeps them in the browser's
cache storage. With WebGPU a picture takes seconds. On WebAssembly (one
thread, because the page is not cross-origin isolated, which Clerk's
sign-in needs) a step takes about 3 s: about 45 s at 16 steps for 256 px,
plus about 2 s for 512 px and 20 s for 1024 px.

Both engines are checked against PyTorch:

- INKOS 1 and 1.1: from the same weights, greedy decoding produces exactly
  the same tokens (`test/engine.test.mjs`).
- The Pro graphs match PyTorch to about 1e-6 (`pro_onnx.py --check`).
- Fed the same starting noise in Chromium, the browser Pro engine produces
  exactly PyTorch's pixels at 256, 512 and 1024 px (`test/pro.browser.mjs`).

The browser draws its own noise from the seed, so a seed does not give the
same picture as in the Python app.

## Plans and billing

The plans are the ones in `configs/plans.yaml`, sold through Clerk Billing:

| Plan | Clerk plan slug | Price (placeholder, test mode) | Models | Largest size | Images per day | Projects |
| --- | --- | --- | --- | --- | --- | --- |
| Basic | `free_user` | free | INKOS 1 | 512 px | 30 | 1 |
| Plus | `user_plus` | $5 / month | INKOS 1, INKOS 1.1 | 1024 px | 300 | 10 |
| Studio | `user_pro` | $15 / month | INKOS 1, INKOS 1.1, INKOS 1 Pro, INKOS 1.1 Pro | 1024 px | unlimited | unlimited |

Prices are set in Clerk, not in this repository. The two paid plans reuse
the slugs Clerk's template created, so no plan had to be deleted.

The Worker reads the plan from Clerk's session token, a JWT whose `pla`
claim holds entries such as `u:user_plus`. It then refuses anything the plan
does not include:

- the weights of a model that is not in the plan;
- a size above the plan's limit;
- an image beyond the day's allowance, counted atomically in D1;
- a project beyond the plan's limit;
- a gallery upload larger than the plan allows.

No Clerk secret key is involved. Tokens are checked against the instance's
public signing keys, and their issuer, expiry and authorised party are
verified (`src/auth.js`).

Because the models run in the browser, a user who has downloaded weights
their plan includes could keep using them outside the app. The daily
allowance applies to everything generated through INKOS Cloud. Hard
enforcement would need inference on a server, which means Workers Paid with
Containers, or a GPU host.

## Deploying

From this directory, with Node 20+ and the Python environment of the main
project (needed only to convert the weights):

```bash
npm install
```

```bash
python3 build.py
```

`build.py` converts `models/inkos1*/weights.pt` into `public/weights/` and
bundles the page into `src/static.gen.js`. Both are generated, not committed.
A Pro model is included when it is installed:

```bash
python3 -m inkos export --model inkos1_pro
```

First deployment only:

```bash
npx wrangler d1 create inkos
```

```bash
npx wrangler kv namespace create inkos-weights
```

Put the two ids into `wrangler.jsonc`, then:

```bash
npx wrangler d1 migrations apply inkos --remote
```

Every deployment:

```bash
./upload_weights.sh
```

```bash
npx wrangler deploy
```

`upload_weights.sh` runs `upload_files.py`. It uploads the weights, the Pro
graphs and onnxruntime-web, and skips files it has already uploaded
unchanged. A KV value holds at most 25 MiB, so larger files are stored in
20 MiB parts: `<key>` holds part 0 with `{"size", "parts"}` metadata, and
`<key>#1` onwards hold the rest. The Worker streams the parts back as one
response with a Content-Length. Rebuild before deploying whenever the
weights change.

### Clerk

1. Create an application and copy its publishable key into
   `CLERK_PUBLISHABLE_KEY` in `wrangler.jsonc`.
2. Turn on Billing for users. Create the plans with the slugs above and the
   features `inkos1`, `inkos1_1`, `inkos1_pro`, `inkos1_1_pro`, `size_1024`,
   `images_300`, `unlimited`.
   This repository's development instance was configured through Clerk's
   API with exactly these settings.
3. For real payments, create a production instance, connect Stripe under
   Billing, and use a domain you own. Then update the publishable key.

## Tests

```bash
python3 build.py && python3 test/make_fixtures.py
```

```bash
npm test
```

There are 18 tests in two groups:

- **Engine:** tokens identical to PyTorch, renders matching Python, PNG
  format, normalisation, word wrap.
- **Worker:** token forgery and expiry, issuer and site checks, plan
  mapping, weight gating (the Pro graphs for Studio only), parts joined
  back into one file, the public runtime route, an atomic quota under
  concurrent requests, project limits, gallery privacy, static serving.

The Pro engine is tested in Chromium (it needs the exported graphs and
Playwright):

```bash
python3 test/make_pro_fixtures.py inkos1_pro inkos1_1_pro
```

```bash
npm run test:pro
```

The Worker tests run on SQLite standing in for D1, with locally signed tokens
standing in for Clerk's.

## What was verified on the live deployment

Through Cloudflare's Browser Rendering API, a Clerk test user
(`inkos-e2e+clerk_test@example.com`, created through Clerk's admin API) was
signed in on https://inkos.playcore.workers.dev. Its real session token
carried `pla: "u:free_user"` and was accepted by the Worker, and as a Basic
user it got:

- **Refusals:** the INKOS 1.1 weights, an INKOS 1.1 picture and 1024 px were
  each refused with 403.
- **Generation:** the INKOS 1 weights downloaded from KV and a 512 px 1-bit
  PNG was drawn in the browser (about 1 s).
- **Records:** the image was counted (1 of 30) and saved to the gallery.

The pricing table renders the three plans from Clerk Billing.

**Not verified here:** paying for Plus or Studio through Clerk's checkout.
Clerk's bot protection rightly blocks automated browsers, so test an upgrade
by hand with Stripe's test card `4242 4242 4242 4242` while signed in.
