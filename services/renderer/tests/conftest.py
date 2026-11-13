import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
FIXTURE = os.path.join(ROOT, "..", "..", "packages", "shared", "test", "fixtures", "sampling.json")


@pytest.fixture(scope="session")
def fixture():
    with open(FIXTURE, "r", encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture()
def scene(fixture):
    return json.loads(json.dumps(fixture["spec"]))
