---
name: write-goodbehavior
description: Edit a document so every word is load-bearing — rules keep their emphasis, rationale goes plain — under a fingerprint gate that proves no rule was lost. Use when prose has inflated (em dashes everywhere, bolded maxims, padded triples) or before shipping a doc a human has to read.
---

**Loop position:** called on its own, or as the last step of any change that edited prose a human will read.

Edit a document so that **every word either enforces or is cut.** The target is not "sounds human" and not
"shorter". It is *load-bearing density*: emphasis spent only where it changes what a reader does.

## The one test

> **Delete the device. If no agent or reader would ACT differently, it was decoration.**

Applies to em dashes, bold, negations, parallelism, and abstraction alike. One test, not a pattern checklist.

## Step 1 — classify before editing

Tag every span. The tag sets what's allowed. **Never edit a span before it is tagged**; most bad edits are
rationale rules applied to a RULE span, or the reverse.

| register | may use | hard limits |
|---|---|---|
| **RULE** | imperative mood, bold, `never`/`must`/`don't` | must name an observable trigger **and** a concrete action |
| **RATIONALE** | plain declarative | ≤2 sentences, no bold, no em dash; exists only to stop one predictable misapplication of the rule |
| **REFERENCE** | verbatim | **untouched** — examples, code, quoted output, provenance, incident records |

Most inflation lives in RATIONALE. Cutting there cannot weaken enforcement, by construction. **Start there and
stop there** unless a RULE is genuinely unclear.

## Step 2 — the six patterns, and which ones actually matter

Count them with `scripts/write/patterns.js` (per 1000 words). **Counts are a yardstick, not a verdict.**

1. **Em dash as default connector.** The biggest and most reliable win. An em dash is the lowest-commitment
   punctuation: it appends without committing to a relation. **Replace with the mark that names the relation** —
   comma (aside), colon (this is what I mean), parens (genuinely optional), or a period. Keep it for a real
   interruption. Budget: **RATIONALE ≤ 5 per 1000 words.** RULE spans are exempt.
2. **Negative parallelism** ("Not X. Not Y." / "it isn't A, it's B"). Cheap to emit, delays the actual claim.
   **Cut it in RATIONALE. Keep it in a RULE** where it names specific cheatable proxies, which is a real list, not a
   rhythm. Check before hunting: it is often already near-zero, and a pass that "fixes" an absent pattern is waste.
3. **Aphoristic bolded rules.** *This one is in direct tension with "bold the rules" and the tension is real:*
   bolding a rule mechanically produces a short bolded declarative. **Resolution: bold the rule, not the moral.**
   A bolded span must contain a trigger and an action a reader can perform. `**Marking done and archiving are one
   action.**` states a rule. `**Writing "done" is only half an edit.**` states a moral — demote it to plain, and
   let the rule beneath it carry the bold. **Expect aphorism density to rise during a de-inflation pass**, and
   check every bolded span against the trigger-and-action test rather than against the count.
4. **Rule of three.** Once "A, B" is written, a third item arrives whether or not it exists. **Count the real
   items and write that many.** A two-item list is finished at two.
5. **Inflated abstraction.** Prefer the concrete noun. **Exception that is not optional: a term the project has
   DEFINED is vocabulary, not inflation.** In GoodBehavior, "the real thing", "evidence", "verify", "profile",
   "the loop" are defined terms — changing them breaks the definitions they point at. Synonym-cycling a defined
   term is the actual error.
6. **Corrective reversal** (state the naive view, then overturn it). **Lead with the claim.** Check it is present
   before spending a pass on it.

## Step 3 — the fingerprint gate (this is what makes the edit safe)

```sh
node scripts/write/fingerprint.js --diff <before-file-or-dir> <after-file-or-dir>
node scripts/write/patterns.js "label" '{"before":["<path>"],"after":["<path>"]}'
```

`fingerprint.js` extracts every obligation the document imposes (obligation clauses, bolded spans, headings),
normalises to content words, and fuzzy-matches before against after. **It fails loudly; it does not prove
anything.** A flag means *a human must look at this*, not *a rule was lost*.

**Adjudicate every flag, by grepping the rewritten file for the obligation — never by reading the score.**
Each flag resolves to exactly one of:
- **present, reworded or sentence-split** → confirmed by grep, no action.
- **deliberate de-emphasis** (text kept, bold removed) → allowed only if the span is RATIONALE. Record it.
- **lost** → **restore it.** A dropped obligation is never an acceptable cost of style.

**Never retune the extractor or the budgets after seeing a result you don't like.** Freeze them first.

## Never touch
Imperative verbs in rules · the negation inside a prohibition (`never`, `don't`) · named failure modes and
counterexamples · operational definitions and their test · provenance and dated incident records · index hook lines
(`— what it's for`) · deliberate asymmetries and the parentheticals explaining them · defined project vocabulary.

## Report
State the before/after pattern counts and the gate result as **numbers**: units checked, flagged, confirmed
present, deliberately de-emphasised, **lost (must be 0)**. **Do not narrate that the prose "reads better."**

> **Scope — this skill edits documents for the humans who read them.** It does not change how an agent writes.
> **An agent's register is governed by an explicit rule, never by the style of the files it reads**, so never
> rewrite an instruction file in order to change an agent's output. The rule lives in the principles' "Register"
> section; edit that instead.
