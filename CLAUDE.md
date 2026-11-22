# warm-cache

Mod do Claude Code (plugin z hookami). Opis w `SPEC.md`.

## Gdzie co leży

- `hooks/register.ts`: kod moda.
- `tests/register.test.ts`: testy.
- `.claude-plugin/`: `plugin.json` (metadane, ustawienia) i `marketplace.json`.

## Sprawdzanie zmian

- Testy (cały zestaw, jeden plik): `claude plugin test .`
- Brak buildu i CI.

## Publikacja

- Publiczne repo na GitHubie. Teksty w kodzie i README po angielsku.
- Przy zmianie wersji podbij `version` w `plugin.json`.
- Zachowaj notę o cache-tax w `LICENSE` i README.
