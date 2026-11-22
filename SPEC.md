# SPEC: warm-cache

## Cel

Mod do Claude Code, który podtrzymuje godzinny cache promptu w przerwach, ale tylko w rozmowach, w których to się opłaca. Publiczna, przemianowana i przetłumaczona na angielski wersja prywatnego moda `cieply-cache` (z `~/.claude/mods`).

## Wymagania

- Pingi tylko powyżej progu kontekstu (`minTokens`, domyślnie 40k) i opcjonalnie progu wiadomości (`minMessages`, domyślnie 0).
- Okno podtrzymania liczone od ostatniej wiadomości (`windowHours`, domyślnie 2 h).
- Limit kosztu pingów na jedną przerwę (`pingFloor`, domyślnie połowa kosztu ponownego zapisu).
- Ostrzeżenie albo pytanie przed wysyłką na zimny cache (`guard`).
- Jednorazowa podpowiedź `/compact` od `compactHint` tokenów (domyślnie 150k).
- Komenda `/warm [status | on | off | auto]`.

## Architektura

- `hooks/register.ts`: cały mod (stan rozmowy, progi, harmonogram pingów, komenda, UI).
- `hooks/hooks.json`: rejestruje moduł.
- `.claude-plugin/plugin.json`: metadane i ustawienia użytkownika.
- `.claude-plugin/marketplace.json`: pozwala instalować repo jako marketplace z jednym pluginem.
- `tests/register.test.ts`: testy na zegarze i silniku z `claude-code/testing`.

## Kluczowe decyzje

- Nazwa `warm-cache`, komenda `/warm`, wszystkie teksty po angielsku (publikacja dla szerszego grona).
- Mechanizm pingów i tabela cen z cache-tax (MIT); nota o prawach autorskich Karana Bansala w `LICENSE`.
- Domyślnie `minMessages = 0`: wystarcza próg tokenów.

## Uruchomienie

```
claude plugin test .
```

Instalacja lokalna: dodać folder jako marketplace (`/plugin marketplace add <ścieżka>`) i zainstalować `warm-cache@warm-cache`. Nie włączać razem z `cieply-cache` ani cache-tax.
