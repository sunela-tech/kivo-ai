"""Text material for synthetic notes, logs, charts and diagrams.

Everything here is original filler written for this project. Because INKOS 1
copies user text through its pointer head, the exact words matter little; the
generators also mix in random strings so pointing does not depend on wording.
"""
from __future__ import annotations

import numpy as np

NAMES = ("Anna Ben Cara Dan Eli Fay Gus Hana Ian Jo Kai Lea Max Nia Omar Pia Quinn Rae Sam Tess Uma Vik Wren "
         "Xan Yara Zed Mia Noah Lena Theo Ivy Jude Mom Dad Alex Robin Sasha Milo Ada Hugo").split()
ITEMS = ("milk eggs bread butter rice pasta apples pears lemons onions garlic tomatoes cheese yogurt coffee tea "
         "sugar salt flour honey oats beans lentils carrots spinach potatoes bananas grapes soap shampoo "
         "toothpaste batteries stamps envelopes tape glue paper pens pencils notebook charger cable light bulbs "
         "candles matches napkins sponge detergent olive oil vinegar pepper noodles tofu chicken fish cereal "
         "juice water cookies chocolate jam nuts raisins").split()
THINGS = ("bike car door window sink shelf lamp printer laptop phone router garden fence roof desk chair "
          "report budget invoice website backup server database schedule ticket form contract slides poster "
          "essay chapter recipe playlist budget plan map list draft sketch model test build release").split()
VERBS = ("Buy Call Email Fix Clean Check Read Write Send Book Pay Return Review Update Plan Print Order Pack "
         "Renew Cancel Finish Start Draft Test Move Sort Wash Water Charge Backup Install Measure Paint").split()
TOPICS = ("Groceries Work Home Garden Travel Ideas Budget Health Reading Project Meeting Errands Weekend Goals "
          "Chores Recipes Repairs Study Fitness Notes Today Tomorrow Monday Friday Packing Birthday Dinner "
          "Research Design Launch Review Roadmap Backlog Sprint Bugs Features Inbox Calls Bills").split()
PLACES = ("office bank library market park station gym cafe school clinic pharmacy post office garage airport "
          "harbor museum bakery studio workshop").split()
DAYS = "Mon Tue Wed Thu Fri Sat Sun".split()
LONG_DAYS = "Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split()
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
EVENTS = ("boot ok", "sync started", "sync done", "backup complete", "user login", "user logout", "disk check",
          "update installed", "restart", "sensor read", "battery low", "wifi lost", "wifi back", "door opened",
          "door closed", "temp 21C", "temp 19C", "error 42", "retry 2", "job queued", "job finished",
          "cache cleared", "page refreshed", "alarm set", "timer end", "note saved", "export done",
          "screen sleep", "screen wake", "charge full")
ACTIVITIES = ("Standup", "Review", "Lunch", "Gym", "Dentist", "Call", "Planning", "Demo", "Workshop", "Break",
              "Deep work", "Email", "Walk", "Shopping", "Laundry", "Reading", "Class", "Dinner", "Meeting",
              "Interview", "Travel", "Cleaning", "Practice", "Study", "Coffee")
FLOW_STEPS = ("Start", "Input", "Check", "Valid?", "Process", "Save", "Print", "Done", "Retry", "Load", "Parse",
              "Ready?", "Send", "Wait", "Log", "End", "Plan", "Build", "Test", "Ship", "Read", "Sort", "Empty?",
              "Draw", "Export", "Scan", "Match?", "Notify", "Idle", "Sync")
NODE_WORDS = ("Design", "Build", "Test", "Launch", "Plan", "Do", "Check", "Act", "Ideas", "Tasks", "Team",
              "Users", "Data", "API", "UI", "DB", "Cache", "Auth", "Docs", "Ops", "Sales", "Support", "Research",
              "Budget", "Risks", "Goals", "Scope", "Time", "Cost", "Quality", "Input", "Output", "Model", "Store",
              "Search", "Queue", "Core", "Edge", "Cloud", "Local")
CHART_LABELS = ("A B C D E F G H", "Mon Tue Wed Thu Fri Sat Sun", "Q1 Q2 Q3 Q4", "Jan Feb Mar Apr May Jun",
                "N S E W", "Red Blue Green", "Rent Food Fun Save", "v1 v2 v3 v4 v5", "S M L XL",
                "Tea Coffee Juice Water", "Car Bus Bike Walk", "2021 2022 2023 2024 2025")
SENTENCES = (
    "Woke up early and went for a walk before breakfast.",
    "The weather was cold but clear all day.",
    "Finished the report and sent it to {name}.",
    "Had lunch with {name} at the {place}.",
    "Spent the afternoon fixing the {thing}.",
    "Need to remember to buy {item} and {item}.",
    "Read two chapters of my book in the evening.",
    "Felt tired but happy with the progress.",
    "Tomorrow I want to start on the {thing}.",
    "Called {name} and talked for an hour.",
    "The {thing} is finally working again.",
    "Rain in the morning, sun after noon.",
    "Cooked dinner with {item} and {item}.",
    "Made a list of ideas for the weekend.",
    "Went to the {place} and came back late.",
    "Slow day, mostly email and small tasks.",
    "Learned something new about the {thing} today.",
    "Slept well and felt much better.",
    "Cleaned the desk and sorted old papers.",
    "Long meeting about the {thing}, no decision yet.",
)

_ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def pick(rng: np.random.Generator, seq):
    return seq[int(rng.integers(len(seq)))]


def gibberish(rng, lo=2, hi=8) -> str:
    n = int(rng.integers(lo, hi + 1))
    return "".join(_ALNUM[int(rng.integers(len(_ALNUM)))] for _ in range(n))


def word(rng) -> str:
    r = rng.random()
    if r < 0.12:
        return gibberish(rng)
    pool = pick(rng, (ITEMS, THINGS, TOPICS, PLACES, NAMES, NODE_WORDS))
    return pick(rng, pool)


def task(rng) -> str:
    r = rng.random()
    if r < 0.3:
        return pick(rng, ITEMS)
    if r < 0.55:
        return f"{pick(rng, VERBS)} {pick(rng, ITEMS)}"
    if r < 0.75:
        return f"{pick(rng, VERBS)} the {pick(rng, THINGS)}"
    if r < 0.85:
        return f"{pick(rng, VERBS)} {pick(rng, NAMES)}"
    if r < 0.92:
        return f"{pick(rng, VERBS)} {pick(rng, NAMES)} at {clock(rng)}"
    return " ".join(word(rng) for _ in range(int(rng.integers(1, 4))))


def title(rng) -> str:
    r = rng.random()
    if r < 0.6:
        return pick(rng, TOPICS)
    if r < 0.8:
        return f"{pick(rng, TOPICS)} {pick(rng, ('list', 'plan', 'notes', 'ideas', 'log'))}"
    if r < 0.9:
        return f"{pick(rng, NAMES)}'s {pick(rng, THINGS)}"
    return gibberish(rng, 3, 9).capitalize()


def label(rng, max_len: int = 9) -> str:
    for _ in range(8):
        w = pick(rng, NODE_WORDS) if rng.random() < 0.8 else word(rng).capitalize()
        if len(w) <= max_len:
            return w
    return w[:max_len]


def clock(rng) -> str:
    h, m = int(rng.integers(0, 24)), int(pick(rng, (0, 0, 5, 10, 15, 20, 30, 30, 40, 45, 50)))
    return f"{h:02d}:{m:02d}" if rng.random() < 0.75 else f"{h}:{m:02d}"


def date(rng) -> str:
    y, m, d = int(rng.integers(2019, 2031)), int(rng.integers(1, 13)), int(rng.integers(1, 29))
    r = rng.random()
    if r < 0.4:
        return f"{y}-{m:02d}-{d:02d}"
    if r < 0.6:
        return f"{d} {MONTHS[m - 1]} {y}"
    if r < 0.75:
        return f"{MONTHS[m - 1]} {d}"
    if r < 0.9:
        return pick(rng, LONG_DAYS)
    return f"{d:02d}/{m:02d}/{y}"


def sentence(rng) -> str:
    s = pick(rng, SENTENCES)
    while "{" in s:
        s = s.replace("{name}", pick(rng, NAMES), 1).replace("{place}", pick(rng, PLACES), 1)
        s = s.replace("{thing}", pick(rng, THINGS), 1).replace("{item}", pick(rng, ITEMS), 1)
    return s


def paragraph(rng, max_chars: int) -> str:
    out = sentence(rng)
    while True:
        nxt = sentence(rng)
        if len(out) + 1 + len(nxt) > max_chars or rng.random() < 0.2:
            return out
        out += " " + nxt
