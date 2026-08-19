# ARK Model Description Localization Design

## Goal

Localize the two Volcengine Coding Plan model descriptions through the provider catalog.

## Scope

This change adds source strings only to the English locale. Crowdin manages the other locale files.

The change does not modify model selection, provider requests, saved settings, or UI components.

## Design

`ProviderExtraMethods.listModels` receives a translation context as its third argument. The provider store supplies its existing `t` function.

ARK model specifications store an optional `descriptionKey`. The shared ARK provider resolves this key before it returns `ModelInfo` objects.

The returned `description` remains a plain string. This keeps provider state serializable for Pinia and cross-window synchronization.

## Data Flow

```text
packages/i18n English source string
  -> ARK model descriptionKey
    -> listModels translation context
      -> localized ModelInfo.description
        -> provider store and model card
```

## Testing

The focused ARK provider test supplies a translation function. The test checks that the model list contains localized descriptions.

The existing model order, deprecation metadata, prefix removal, and BytePlus behavior remain covered.

## Alternatives

Adding `descriptionKey` to `ModelInfo` leaks i18n details into runtime model data. Importing global i18n state creates a one-off dependency in the provider helper.

Both alternatives are less suitable than passing translation context through the provider catalog boundary.
