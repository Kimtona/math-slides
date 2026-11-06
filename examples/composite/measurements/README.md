# Measurements for `test_composite.png` (real GUI, real model)

All numbers come from `tests/sketch-ollama-e2e.mjs` (real Electron app, real Ollama, no fixtures), 2026-11-06, MacBook (Apple Silicon),
Ollama `qwen2.5vl:7b`, `temperature 0`, `num_ctx 16384`. "Total" = click on *Convert to Editable Slide* → preview ready
(`wallMs` in the summaries). Ollama's own counters (`prompt_eval_duration`, `eval_duration`, `load_duration`, token counts) are in `*.ollama-usage.json`.

| File | What | Total | Ollama |
|---|---|---|---|
| `layout-mode.summary.json` / `layout-mode.ollama-usage.json` | Layout Mode (coordinates, JSON), original image | **215.0 s** | ≈1,400 output tokens |
| `document-mode.distinct-images.*` | Document Mode, 3 differently resized copies (830/850/820 px wide), model warm | **35.2 / 35.3 / 35.1 s** | prompt 10.6–11.4 s + generation 23.5–24.4 s, 1127 in / 176 out tokens |
| `document-mode.same-image.*` | Document Mode, same image 3× in a row | 42.2 / 23.6 / 23.9 s | run 1: model load 6.9 s + prompt 11.5 s + 23.5 s; runs 2–3: prompt 0.07 s (**Ollama prompt cache, not representative**) |
| `markdown-experiment.log` | the first single Markdown experiment (raw 840×1580 image, cold model) | 55.3 s | load 9.3 + prompt 21.4 + eval 24.3 s, 176 out tokens |

Why the difference: generation runs at ≈6.6–7.5 tokens/s on this machine. Layout Mode asks for JSON with an id, a type and four box
coordinates per element (≈1,400 tokens ≈ 215–245 s). Document Mode asks for Markdown without positions (176 tokens ≈ 24 s); the prompt
evaluation (≈11 s for 1127 tokens, image ≈ 1000 tokens) is the other fixed cost. The Markdown is identical in all runs (greedy decoding).

Reproduce (needs `ollama serve` with `qwen2.5vl:7b`):
```bash
mkdir -p /tmp/variants && for w in 830 850 820; do sips --resampleWidth $w ~/Downloads/test_composite.png --out /tmp/variants/test_composite_$w.png; done
node tests/sketch-ollama-e2e.mjs /tmp/out-doc /tmp/variants/test_composite_830.png /tmp/variants/test_composite_850.png /tmp/variants/test_composite_820.png   # Document Mode (default)
SKETCH_MODE=layout node tests/sketch-ollama-e2e.mjs /tmp/out-layout ~/Downloads/test_composite.png                                                      # Layout Mode
```
(The distinct copies avoid Ollama's prompt cache; the first run after the model was idle also pays the 7–9 s load.)
