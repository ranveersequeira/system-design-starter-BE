# System Design

A local web app for learning system design through 35 chapters of explanations,
quizzes, recall exercises, and design practice.

## Run it

```bash
cd system-design   # after cloning the repository
pnpm install   # or npm install
pnpm dev       # http://localhost:5173
```

## How the app teaches

| Mode | What it does | Technique |
| --- | --- | --- |
| Learn | Chapter split into 5-8 pages, each with a mental model, ASCII diagram, key points, and a "pause and predict" checkpoint you must answer before revealing | Active recall, prediction error |
| Quiz | 10-14 questions per chapter (single choice, multi select, true/false, short answer with self-graded rubric), instant explanations, wrong answers saved and drillable | Retrieval practice |
| Feynman | Write a plain-language explanation, compare with the model explanation, tick "must mention" points, self-rate | Feynman technique |
| Memory palace | Themed location per chapter with vivid images at each stop; "recall mode" hides the concepts | Method of loci |
| Flashcards + Review | 12-18 cards per chapter scheduled with SM-2 spaced repetition; the Review page shows what is due today | Spaced repetition |
| Quick revision | 8-14 one-liners per chapter; "active recall" mode hides them | Compressed revision |
| Design practice | Case-study chapters (25-35) walk through requirements, estimation, API, data model, HLD, deep dive, failure modes; you write first, then reveal the reference | Deliberate practice |
| My notes | Markdown notes per chapter, with starter notes in chapter 1 | Elaboration |

Progress lives in the browser's localStorage. Use Settings to export/import a JSON backup.

All 35 chapters are included. Run `pnpm validate` to check chapter completeness and
content structure, and `pnpm build` to type-check and build the app. See
[content sources](docs/content-sources.md) for references and assumptions behind
the completed chapters.

## Adding your own content

1. Write your summaries and questions in a chapter's **My notes** tab, or
2. Edit `src/content/chapters/chNN.ts` directly. The schema is documented in
   `src/content/types.ts`; `ch01.ts` is a complete example. `pnpm build` type-checks it.

## Project layout

```
src/content/types.ts       content schema
src/content/chapters/      one file per chapter (auto-discovered)
src/content/modules.ts     the 7 modules
src/lib/store.ts           localStorage progress store
src/lib/srs.ts             SM-2 scheduler
src/pages/                 one component per screen
```
