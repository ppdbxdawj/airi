# ARK Model Description Localization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Localize Volcengine Coding Plan model descriptions through the provider model catalog.

**Architecture:** Add translation context to `ProviderExtraMethods.listModels` and pass it from every catalog caller. ARK model specifications store translation keys, and the shared helper returns localized plain strings.

**Tech Stack:** TypeScript, Vue I18n, Pinia, YAML, Vitest, ESLint

---

## Task 1: Reproduce the localization error

**Files:**
- Modify: `packages/stage-ui/src/libs/providers/providers/ark-providers.test.ts`

**Step 1: Write the failing test**

Add a focused regression test for the PR review. Supply a translation function to `listModels` and expect translated model descriptions.

```ts
// https://github.com/moeru-ai/airi/pull/2321#discussion_r3810499979
it('localizes Volcengine model descriptions for the PR #2321 review', async () => {
  const t = ((key: string) => ({
    'settings.pages.providers.provider.volcengine-coding-plan.models.ark-code-latest.description': 'Localized alias description',
    'settings.pages.providers.provider.volcengine-coding-plan.models.legacy.description': 'Localized legacy description',
  }[key] ?? key)) as ComposerTranslation

  // Create the provider and list its models with { t }.
  // Expect the alias and legacy entries to use the localized values.
})
```

**Step 2: Run the focused test**

Run:

```bash
pnpm -F @proj-airi/stage-ui exec vitest run src/libs/providers/providers/ark-providers.test.ts
```

Expected: FAIL because the current ARK catalog ignores the translation context.

## Task 2: Pass translation context through the model catalog

**Files:**
- Modify: `packages/stage-ui/src/libs/providers/types.ts`
- Modify: `packages/stage-ui/src/stores/providers/provider.ts`
- Modify: `packages/stage-ui/src/libs/providers/validators/openai-compatible.ts`
- Modify: direct `listModels` test callers found by `rg`

**Step 1: Extend the catalog contract**

Add a required third argument to `ProviderExtraMethods.listModels`.

```ts
interface ProviderExtraMethods<TConfig> {
  listModels?: (
    config: TConfig,
    provider: ProviderInstance,
    contextOptions: { t: ComposerTranslation },
  ) => Promise<ModelInfo[]>
}
```

**Step 2: Pass the context from production callers**

The provider store passes its existing `t` function.

```ts
definition.extraMethods.listModels(config, provider, { t })
```

The OpenAI-compatible validators pass the `t` function that their validator factory already receives.

**Step 3: Update direct test callers**

Pass an identity translation function when a test calls `listModels` directly and does not inspect localized text.

## Task 3: Move the descriptions to the English source locale

**Files:**
- Modify: `packages/stage-ui/src/libs/providers/providers/ark-shared.ts`
- Modify: `packages/stage-ui/src/libs/providers/providers/volcengine-coding-plan/index.ts`
- Modify: `packages/i18n/src/locales/en/settings.yaml`

**Step 1: Replace the ARK model description field**

```ts
interface ArkModelSpec {
  id: string
  contextLength?: number
  deprecated?: boolean
  descriptionKey?: string
}
```

**Step 2: Resolve the key in the shared helper**

```ts
listModels: async (_config, _provider, { t }) => models.map((model) => {
  // Build ModelInfo.
  if (model.descriptionKey !== undefined)
    modelInfo.description = t(model.descriptionKey)
  return modelInfo
})
```

**Step 3: Add English source strings**

Add `models.ark-code-latest.description` and `models.legacy.description` under the Volcengine Coding Plan provider locale section.

Do not edit other locale files. Crowdin manages these translations.

**Step 4: Run the focused test**

Run the command from Task 1.

Expected: PASS with all ARK provider tests successful.

## Task 4: Verify and publish the review fix

**Files:**
- Verify all modified files

**Step 1: Run type checking**

```bash
pnpm -F @proj-airi/stage-ui typecheck
```

Expected: PASS.

**Step 2: Run lint**

Run ESLint on every modified TypeScript file. Run the i18n package lint or YAML check for the English locale file.

Expected: PASS.

**Step 3: Check the diff**

```bash
git diff --check
```

Expected: PASS.

**Step 4: Commit once after verification**

```bash
git add <modified files>
git commit -m "fix(stage-ui): localize ARK model descriptions"
```

**Step 5: Push the current branch**

```bash
git push origin fix/volcengine-coding-plan-models
```

Expected: PR #2321 updates with the review fix.
