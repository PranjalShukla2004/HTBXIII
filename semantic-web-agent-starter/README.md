# Semantic Web Agent — local semantic transfer MVP

**Goal:** Record a simple enquiry on one site and replay its intent on another using a local embedding model, without any hosted LLM or API integration.

## Setup (macOS, Linux, WSL, Windows PowerShell with adapted venv command)

Install Python 3.11 or 3.12 and Git. Then:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -m playwright install chromium
pytest -q
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1` and use `py -3.12 -m venv .venv` if required.

## Try the two included fake manufacturer websites

**Terminal 1 — serve local pages:**

```bash
python -m http.server 8000
```

**Optional pre-recorded example (skip recording to inspect the format):**

```bash
cat examples/sample_workflow.json
```

**Terminal 2 — record the example:**

```bash
source .venv/bin/activate
playwright codegen --target=python -o recordings/manufacturer_a.py http://localhost:8000/examples/manufacturer_a.html
```

In the browser opened by Codegen, fill the three fields using **fake** information, and click *Send Enquiry*. Close Codegen. The output Python script contains actual locator interactions, NOT a semantic workflow.

**Translate the recording into a restricted JSON workflow:**

```bash
swa import-demo recordings/manufacturer_a.py --out workflows/manufacturer_a.json
cat workflows/manufacturer_a.json
```

Review the generated JSON: this deliberately limited parser handles `fill`, `click`, `check`, `uncheck` and `select_option` using named locators. It ignores many complicated Playwright patterns and cannot infer every higher-level intent.

**Inspect Manufacturer B's controls:**

```bash
swa inspect --url http://localhost:8000/examples/manufacturer_b.html
```

**Preview semantic matches without editing the page:**

```bash
swa replay --workflow workflows/manufacturer_a.json \
  --url http://localhost:8000/examples/manufacturer_b.html
```

The first run downloads the small public Sentence Transformers model from Hugging Face (internet required once). Later inference is local. If you want to test the starter without recording, replace `workflows/manufacturer_a.json` in replay commands with `examples/sample_workflow.json`.

**Fill the form, but stop before the last click:**

```bash
swa replay --workflow workflows/manufacturer_a.json \
  --url http://localhost:8000/examples/manufacturer_b.html --execute
```

**On the local fake site only, ask for approval before the final click:**

```bash
swa replay --workflow workflows/manufacturer_a.json \
  --url http://localhost:8000/examples/manufacturer_b.html --execute --submit
```

## Architecture

`Playwright codegen -> AST import -> workflow JSON -> DOM discovery -> SentenceTransformer ranking -> confidence gate -> Playwright execution`

- `src/semantic_web_agent/recorder_import.py`: AST-based importer. Never executes untrusted recording code.
- `src/semantic_web_agent/dom.py`: discovers visible top-document controls, their form labels, placeholders and nearby context.
- `src/semantic_web_agent/semantic.py`: local cosine similarity plus lexical matching; restricts candidates by action type.
- `src/semantic_web_agent/replay.py`: previews or executes candidate actions; deliberately blocks uncertain mappings and last-click submission unless the user confirms.
- `examples/`: local no-network forms for controlled testing.
- `tests/`: safe parser regression tests.

## Limitations (important)

- This is **not** a production agent. It handles simple forms only, and its codegen importer supports a subset of Python locator patterns.
- It does not yet support cross-origin iframes, shadow DOM, custom selects, CAPTCHA, dynamic multi-page forms, chatbot conversations or reliable success detection.
- It is **not trained** from one demonstration: it reuses a pretrained sentence-embedding model to match labels. Recordings supply the intended sequence and values, not new learned model weights.
- Semantic similarity is not semantic equivalence: `business email` could be confused with `billing email`. Low-confidence mappings stop, but high scores can still be wrong. Always review before real submission.
- The tool currently considers only visible UI controls in the top document. A navigation click might change the page and lead to a new discovery pass, but multi-step workflow support is experimental.
- Using `--submit` only approves the final recorded click, and **does not prove** that a real enquiry was accepted. Validate a success indicator separately.
- Only run against sites you are authorized to automate, with reasonable rates. Never include real passwords, tokens, personal information or customer data in recorded scripts.

## Planned improvements

1. Collect before/after DOM snapshots and action effects during demonstrations.
2. Record semantic roles and workflow goals (not only the codegen locator's text).
3. Use a global, one-to-one matching strategy instead of greedy sequential ranking.
4. Handle frames, shadow DOM, dynamic forms and state-dependent branches.
5. Introduce a visual fallback and optional LLM only for ambiguous cases.
6. Add verification and reproducible success/failure benchmarks.

## GitHub

```bash
git init
git add .
git commit -m "Bootstrap semantic web agent"
git branch -M main
# Create an empty GitHub repository, then:
git remote add origin git@github.com:YOUR_ORG/semantic-web-agent.git
git push -u origin main
```

Do not commit scripts containing real enquiry data or authenticated browser state. `recordings/`, `workflows/`, and `artifacts/` are ignored by default.
