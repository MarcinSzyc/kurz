<p align="center">
  <img src="design/icon.png" width="180" alt="Ikona Kurz: puchata kulka kurzu z dużymi oczami">
</p>

<h1 align="center">Kurz</h1>

<p align="center">
  Aplikacja na macOS, która pokazuje, co zajmuje miejsce na dysku, i pomaga je bezpiecznie odzyskać.
</p>

---

## Co robi

Kurz skanuje folder domowy, buduje drzewo rozmiarów wszystkich plików i folderów, a potem podpowiada, co można bezpiecznie usunąć, i pokazuje mapę, na której od razu widać, gdzie „zbiera się kurz”. Docelowy wygląd jest w [`design/`](design/).

| Funkcja | Status |
|---|---|
| Szybki, równoległy skan folderu z postępem na żywo i możliwością anulowania | ✅ gotowe |
| Pasek dysku w nagłówku: wolne miejsce i zajętość | ✅ gotowe |
| Jasny i ciemny motyw: domyślnie jak w macOS, przełącznik ◐ ☀ ☾ w nagłówku | ✅ gotowe |
| Wskaźnik w pasku menu macOS: pierścień zajętości dysku, konfigurowalny tekst, kolor pomarańczowy/czerwony po przekroczeniu progów | ✅ gotowe |
| Ekran „How it works”: jak działa skan, kategorie, reguły rekomendacji i usuwania, generowany z tych samych reguł, których używa apka | ✅ gotowe |
| Ekran **Clean up**: cel „I need X GB” sam napełnia koszyk najbezpieczniejszymi pozycjami; trzy grupy: *Safe to delete*, *Rebuildable*, *Take a look*; data ostatniej zmiany każdej pozycji | ✅ gotowe |
| Czyszczenie z wyborem przy każdym usunięciu: do Kosza albo na stałe; Undo; „Empty from Trash” usuwa tylko pozycje z tego sprzątania | ✅ gotowe |
| Ekran **Map**: spokojna mapa kafelkowa z dwoma poziomami, kolory według kategorii, kliknięcie kafelka dodaje folder do koszyka wspólnego z Clean up, › wchodzi do folderu, „Only removable” przygasza foldery z Twoimi plikami | ✅ gotowe |
| Zakładka **History**: odzyskane miejsce, tempo zapełniania dysku, wykres wolnego miejsca (30/90 dni) z zaznaczonymi sprzątaniami, poprzednie sprzątania z przywracaniem pojedynczych pozycji z Kosza, foldery, które odrastają | ✅ gotowe |
| Automatyczne cotygodniowe sprzątanie folderów, które odrastają | 📋 planowane |
| Gotowy skrypt shell zamiast usuwania z apki | 📋 planowane |

### Zasady bezpieczeństwa

- **Przy każdym usuwaniu wybierasz sposób:** przeniesienie do Kosza (domyślnie, można przywrócić przez „Odłóż z powrotem”) albo trwałe usunięcie (miejsce zwalnia się od razu, nie da się cofnąć).
- Nic nie dzieje się bez zaznaczenia przez Ciebie. Rekomendacje to tylko podpowiedzi.
- Skan tylko czyta i niczego na dysku nie zmienia.
- Niektórych miejsc Kurz nigdy nie rusza: Dokumenty, Biurko, Zdjęcia, iCloud Drive, Poczta, Wiadomości, pęki kluczy, `~/.ssh`, `~/.gnupg`.

## Jak to działa

```
┌──────────────────────────── Kurz.app ─────────────────────────────┐
│                                                                   │
│  Interfejs (React + TypeScript, w webview systemu)                │
│    • kafelki z informacjami, mapa, lista (rekomendacje: wkrótce)  │
│    • układ mapy liczony przez d3-hierarchy (squarified treemap)   │
│                 ▲ zdarzenia: postęp, koniec skanu                 │
│                 │ polecenia: start_scan, get_tree, disk_info      │
│  Rdzeń (Rust)   ▼                                                 │
│    • scanner.rs: równoległe przejście po katalogach (rayon)       │
│    • disk.rs: pojemność wolumenu (statfs)                         │
│    • categories.rs: kategorie folderów (kolory mapy)              │
│    • menubar.rs + gauge.rs: wskaźnik w pasku menu                 │
│    • settings.rs: ustawienia w pliku JSON                         │
│    • rules.rs: reguły rekomendacji, miejsca chronione             │
│    • drzewo rozmiarów trzymane w pamięci                          │
└───────────────────────────────────────────────────────────────────┘
```

1. **Skan.** Rust przechodzi po katalogach równolegle na wszystkich rdzeniach procesora. Każdy podfolder to osobne zadanie dla puli wątków rayon. Co 150 ms do interfejsu trafia zdarzenie z postępem: liczba plików, folderów, bajtów i błędów.
2. **Liczenie rozmiaru.** Kurz liczy miejsce faktycznie zajęte na dysku (`st_blocks × 512`), tak jak `du`, a nie rozmiar „logiczny”. Dzięki temu pliki rzadkie i skompresowane nie zawyżają wyniku.
3. **Pułapki, które skaner omija:**
   - nie wchodzi w dowiązania symboliczne, więc niczego nie liczy dwa razy i nie wpada w pętle;
   - pomija inne woluminy zamontowane wewnątrz skanowanego folderu;
   - plik z kilkoma twardymi dowiązaniami liczy tylko raz;
   - folder bez uprawnień zalicza jako „nieczytelny” i skanuje dalej.
4. **Drzewo w pamięci.** Wynik skanu to drzewo w pamięci procesu Rust. Interfejs pobiera tylko fragment, który akurat pokazuje (`get_tree(path, depth)`). Pozycje zbyt małe, by były widoczne, są łączone w jedną, więc nawet przy milionach plików do interfejsu trafia niewiele danych.

5. **Usuwanie.** Tuż przed usunięciem każda ścieżka jest sprawdzana ponownie: czy istnieje, czy leży w folderze domowym (także po rozwinięciu dowiązań) i czy nie jest w miejscu chronionym. Kosz obsługuje systemowe `NSFileManager`. Kurz zapamiętuje, gdzie w Koszu trafiła każda pozycja, więc Undo odkłada ją na miejsce, a historia sprzątań trafia do `history.json` obok ustawień.
6. **Rekomendacje.** Reguły w [`rules.rs`](src-tauri/src/rules.rs) opisują, co Kurz może zaproponować do usunięcia: ścieżkę albo nazwę folderu z warunkiem (np. `node_modules` obok `package.json`, tylko w projektach nieruszanych od 30 dni), poziom ryzyka (*Safe* albo *Review*), powód i sposób przywrócenia. Lista miejsc chronionych jest w tym samym pliku, a testy pilnują, żeby żadna reguła do nich nie sięgała. Pełny opis jest w apce, w zakładce **How it works**, generowanej prosto z tych reguł.

**Bazy danych nie ma i nie jest potrzebna.** Drzewo z ~3 mln plików mieści się w kilkuset MB RAM i powstaje od nowa przy każdym skanie. Na dysk trafiają tylko dwa małe pliki JSON w `~/Library/Application Support/com.marcinszyc.kurz/`: `settings.json` (ustawienia) i `history.json` (sprzątania, próbki wolnego miejsca najwyżej co godzinę, rozmiary rekomendowanych pozycji raz dziennie; dane starsze niż 120 dni są usuwane).

## Dlaczego takie technologie

**Rust: rdzeń i skaner.** Skanowanie dysku to miliony wywołań systemowych i sporo pracy procesora. Rust daje:
- wydajność na poziomie C bez garbage collectora, co ma znaczenie przy milionach obiektów w drzewie;
- bezpieczne wielowątkowe przechodzenie po katalogach; z rayon to kilka linijek, a kompilator pilnuje, żeby nie było wyścigów;
- bezpośredni dostęp do API systemu (`statfs`, metadane plików) bez dodatkowych warstw.

Przykład: skan `~/Prywatne` (9,5 GB, 188 tys. plików) trwa 2,3 s w wersji release.

**Tauri 2: szkielet aplikacji.** Łączy rdzeń w Rust z interfejsem webowym:
- apka jest mała, kilka MB, bo korzysta z wbudowanego w macOS WebKitu, zamiast dołączać całego Chromium jak Electron;
- komunikacja Rust ↔ interfejs to proste polecenia i zdarzenia;
- system uprawnień pozwala interfejsowi tylko na to, co jawnie dopuszczone;
- w razie potrzeby da się zbudować wersję na Windows i Linuksa.

**React + TypeScript: interfejs.** Interaktywne wizualizacje (mapa, zaznaczanie, panele) najwygodniej robi się w technologiach webowych. TypeScript pilnuje zgodności typów z tym, co zwraca Rust.

**d3-hierarchy: układ mapy.** Sprawdzona implementacja algorytmu squarified treemap, który dzieli prostokąt na kafelki o proporcjach jak najbliższych kwadratu. Używamy tylko liczenia układu, rysuje React.

**Vite + pnpm: budowanie interfejsu.** Vite daje błyskawiczny serwer deweloperski z natychmiastowym przeładowaniem. pnpm jest szybki i oszczędny na miejscu na dysku, co przy aplikacji do sprzątania dysku wypada docenić.

## Uruchomienie

### Wymagania

- macOS 11 lub nowszy
- [Rust](https://rustup.rs) (stable)
- [Node.js](https://nodejs.org) 20+ i [pnpm](https://pnpm.io)
- Xcode Command Line Tools: `xcode-select --install`

### Tryb deweloperski

```bash
pnpm install
pnpm tauri dev
```

Otwiera okno aplikacji z automatycznym przeładowaniem po zmianach w interfejsie i w Rust.

### Budowanie aplikacji

```bash
pnpm tauri build
```

Gotowa aplikacja trafia do `src-tauri/target/release/bundle/macos/Kurz.app`, a instalator do `src-tauri/target/release/bundle/dmg/`.

### Testy

```bash
cd src-tauri && cargo test
```

### Pomiar szybkości skanera z wiersza poleceń

```bash
cd src-tauri && cargo run --release --example scan -- ~/Projects
```

### Pasek menu

Kurz pokazuje w pasku menu macOS mały pierścień, który zapełnia się razem z dyskiem, i krótki tekst: procent zajętego miejsca, zajęte z całości albo wolne miejsce. Od 80% pierścień robi się pomarańczowy, od 90% czerwony. Progi, tekst i częstotliwość odświeżania ustawisz w **Menu bar…** w oknie aplikacji. Ustawienia trafiają do `~/Library/Application Support/com.marcinszyc.kurz/settings.json`.

Gdy wskaźnik jest włączony, zamknięcie okna tylko je chowa i Kurz działa dalej w pasku menu. Okno otworzysz z menu wskaźnika albo klikając ikonę w Docku. Żeby zamknąć aplikację, wybierz **Quit Kurz** z menu wskaźnika.

### Uprawnienia macOS

Przy pierwszym skanie macOS zapyta o dostęp do Biurka, Dokumentów i Pobranych. Żeby przeskanować wszystko, także dane aplikacji w `~/Library`, nadaj Kurz pełny dostęp do dysku: **Ustawienia systemowe → Prywatność i ochrona → Pełny dostęp do dysku**. Bez tego część folderów pojawi się jako „nieczytelne”.

## Struktura projektu

```
kurz/
├── src/                    # interfejs (React + TypeScript)
│   ├── App.tsx
│   ├── components/         # CleanUp, MapView, HistoryView, Tray, MenuBarSettings, HowItWorks
│   └── lib/                # wywołania Rusta, formatowanie
├── src-tauri/              # rdzeń (Rust)
│   ├── src/scanner.rs      # równoległy skaner + testy
│   ├── src/disk.rs         # informacje o wolumenie
│   ├── src/categories.rs   # kategorie folderów
│   ├── src/menubar.rs      # wskaźnik w pasku menu
│   ├── src/gauge.rs        # rysowanie ikony-pierścienia
│   ├── src/settings.rs     # ustawienia (JSON)
│   ├── src/rules.rs        # reguły rekomendacji i miejsca chronione
│   ├── src/recommend.rs    # dopasowanie reguł do skanu
│   ├── src/cleanup.rs      # sprawdzanie ścieżek, Kosz, usuwanie, przywracanie
│   ├── src/history.rs      # historia: sprzątania, wolne miejsce, rozmiary (JSON)
│   ├── src/lib.rs          # polecenia i zdarzenia Tauri
│   ├── examples/scan.rs    # benchmark z linii poleceń
│   └── tauri.conf.json     # konfiguracja okna i paczki
└── design/                 # docelowy design (mockup.html) i ikona
```

## Jak powstaje ten projekt

Kurz jest budowany agentowo, z agentem AI (Claude Code), **na czystych promptach**:

- **Bez skilli.** Nie używamy gotowych skilli ani własnych zestawów instrukcji dla agenta. Każdy krok to zwykła rozmowa: opis, czego chcemy, screen albo uwaga do wyniku.
- **Bez wiki.** Nie prowadzimy osobnej bazy wiedzy ani dokumentacji dla agenta. Źródłem prawdy są kod, testy, historia gita i ten README.
- **Lekko.** Apka ma być mała i szybka: minimum zależności, bez bazy danych, bez serwera, bez ciężkich frameworków. Każdą nową zależność trzeba uzasadnić.

Pracujemy małymi krokami: plan etapu, implementacja, testy, commit. Każdy commit jest podpisany jako współtworzony z agentem.

## Ikona

Puchata kulka kurzu z dużymi oczami, inspirowana klimatem filmów studia Ghibli. To oryginalna grafika, narysowana w SVG na potrzeby tego projektu. Źródło: [`design/icon.svg`](design/icon.svg).
