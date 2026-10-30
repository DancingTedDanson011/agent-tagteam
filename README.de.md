# CLI Organizer

Ein Fenster für alle deine Terminals. Laufende cmd-, PowerShell- und Windows-Terminal-Fenster
werden hineingezogen, laufen unverändert weiter und lassen sich in mehreren Ansichten ordnen.
Ist ein Agent (z. B. Claude Code) fertig oder braucht dich, bekommt seine Session ein Badge.

*English:* one window for all your terminals. Drag running cmd, PowerShell and Windows Terminal
windows in; they keep running unchanged. The UI speaks German and English: it starts in your Windows
language, and the **DE | EN** switch in the title bar changes it and remembers the choice.

## Starten

[Portable Windows-Vorabversion herunterladen](../../releases/download/v0.6.1/CLI-Organizer-0.6.1-portable.exe) und doppelklicken. Keine Installation nötig.

## Projekt-Cockpit

Die Vorabversion ergänzt eine Übersicht für Projekte, Sessions und Rückfragen, ein Aufgabenboard sowie Verträge mit tatsächlich ausgeführten Checks und ausdrücklicher manueller Abnahme. Projekte, Aufgaben und Prüfnachweise bleiben lokal gespeichert und werden beim Wiederöffnen geladen. Änderungen am Quellstand machen ältere Nachweise ungültig. [Cockpit-Anleitung](docs/cockpit-usage.md).

Das beobachtende Claude-Plugin ist optional. Reale Frage- und Permission-Hookabläufe müssen weiterhin manuell geprüft werden.

## Bedienung

| Was | Wie |
|---|---|
| Terminal einfangen | Terminal an der Titelleiste greifen und über CLI Organizer loslassen, oder **Terminal einfangen** → aus der Liste wählen (der Dialog bleibt offen für weitere, zu mit X oder Esc) |
| Ansicht wechseln | Fokus · Raster · Frei · Tabs oben in der Mitte, oder `Strg+1` … `Strg+4` |
| Fokus-Ansicht | eine Session groß, die anderen als Live-Vorschau rechts; Klick auf eine Vorschau macht sie groß |
| Ins Dock legen | Minimieren-Symbol im Kopf einer Session; Klick im Dock holt sie zurück |
| Terminal nach vorn holen | Klick auf den Namen im Kopf einer Session |
| Freigeben | Pfeil-Symbol im Kopf: das Terminal bekommt Größe, Position und Rahmen exakt zurück |
| Workspaces | **Workspaces** → aktuelle Anordnung unter einem Namen speichern, später anwenden. Fehlende Fenster öffnet der Workspace neu (siehe unten) |
| Name und Farbe | Farbquadrat links im Kopf einer Session (oder Doppelklick auf den Namen) → Name und eine von acht Farben; sichtbar im Kopf, auf der kleinen Karte, im Dock und in den Tabs |
| Frei-Ansicht | Kachel am Kopf verschieben, Ecke unten rechts zieht die Größe; Pfeiltasten auf der Ecke verschieben |
| Reihenfolge der kleinen Fenster (Fokus) | Vorschau nach oben/unten ziehen, oder `Alt+↑/↓` auf der Vorschau |
| Herausgezogenes Terminal zurückholen | Klick auf eine Ansicht (auch die aktive) setzt alle zurück; **Zurückholen** im Kopf nur dieses; oder das Fenster zurück über die App ziehen |
| Weitere Instanz | **Neue Instanz** öffnet einen zweiten, unabhängigen Organizer |
| Terminal von anderer Instanz holen | In **Terminal einfangen** stehen auch Terminals anderer Organizer („in anderem Organizer“) → **Übernehmen**; oder das Fenster hinüberziehen |
| Sprache | **DE / EN** oben rechts; startet in der Sprache von Windows, die Wahl bleibt gespeichert |
| Konsole schnell öffnen | Leiste unten: **PowerShell** oder **Konsole**; ein eingefügter Ordner (auch `"C:\…"`, `C:/…`, `~`) wird ihr Startordner, Enter öffnet PowerShell |
| Kopieren / Einfügen in Kacheln | Markieren mit der Maus, `Strg+C` kopiert (ohne Markierung bleibt es der Abbruch), `Strg+V` fügt ein, Rechtsklick kopiert oder fügt ein. Nutzt das Programm die Maus (z. B. Claude Code): **Umschalt + Ziehen** markiert. Eingefügter Text verliert Steuerzeichen (außer Tab und Zeilenumbruch), damit er nie als Tastendruck ankommt; eine Markierung über 1 MB wird nicht kopiert und bleibt markiert |
| Freigabe für KI-Kacheln | Agenten-Symbol oben rechts auf der kleinen Karte, oder **Für KI-Kacheln freigeben** im Kopf: deine Claude-, Codex- und OpenCode-Kacheln dürfen sie dann lesen und darin tippen |
| Geöffnete Session (Fokus) | bleibt in der Liste rechts, hervorgehoben mit „Geöffnet“ und einer Live-Vorschau |
| Sprach-Eingabe | **Sprechen** unten rechts klicken (noch einmal: fertig), oder **„-“ gedrückt halten** und sprechen, loslassen: Der Text wird ins zuletzt angeklickte Terminal getippt, **ohne Enter**. Kurz tippen schreibt weiter ein Minus. Einstellungen (Taste, Sprache, Modell): Symbol daneben |

### Sprach-Eingabe

- Erkennung **lokal** mit Whisper (faster-whisper, auf der Grafikkarte, sonst CPU). Die Stimme
  verlässt den PC nicht. Voraussetzung: Python mit dem Paket faster-whisper im PATH; fehlt es, sagt
  der Knopf das. Das Modell lädt beim ersten Diktat einmal (gemessen 12,6 s inkl. Laden auf einer
  RTX 5090) und bleibt dann bereit.
- Beim ersten Klick fragt Windows nach dem **Mikrofon**. Die App erlaubt nur Ton, keine Kamera. Ist
  das Mikrofon in Windows gesperrt: Einstellungen → Datenschutz → Mikrofon → Desktop-Apps.
- Der Text geht in Agenten-Kacheln direkt ins Terminal, in eingefangene Fenster als Tastendruck. Die
  Taste „-“ wirkt nur, wenn der Organizer vorn ist; in eingefangenen Fenstern nimmt man den Knopf.

### Das Badge „Wartet auf dich"

- Claude-Code-Sessions: exakt über den Fenstertitel (Claude Code setzt `◐`/`◑` beim Arbeiten und `✳` im Leerlauf).
- Alle anderen Terminals: über den Bildinhalt. Nach einer Arbeitsphase (mindestens 1,5 s Ausgabe) und 4 s Ruhe erscheint das Badge, einmal pro Phase. Ein blinkender Cursor zählt nicht.
- Kein Badge für die Session, die du gerade ansiehst. Klick auf die Session löscht es.
- Warst du mit minimierter App weg, bekommt jede Session ein Badge, deren Inhalt sich inzwischen geändert hat.

## Workspaces bringen Fenster zurück

Ein Workspace merkt sich neben Ansicht und Anordnung auch **Name, Farbe und Ordner** jeder Session.
Beim Anwenden kommen offene Sessions an ihren Platz; **fehlende öffnet er neu**, nacheinander, mit
einem Hinweis „3 von 5 Fenstern“, und fängt sie wieder ein:

| War es … | kommt zurück als … |
|---|---|
| eine Kachel (PowerShell, Konsole, Claude, Codex, OpenCode) | dieselbe Kachel im selben Ordner, gleiche Rolle |
| ein klassisches Konsolenfenster (cmd, PowerShell) | ein neues Fenster derselben Shell im selben Ordner |
| ein Windows-Terminal-Fenster | ein **eigenes** neues Windows-Terminal-Fenster (nie ein Tab in einem deiner Fenster), mit dem Namen als Titel und der Farbe als Tab-Farbe |

- **Ordner:** Bei klassischen Konsolen liest die App ihn beim Speichern aus dem Prozess. Windows
  Terminal verrät ihn nicht (ein Prozess für alle Fenster). Dafür zeigt der Dialog beim Speichern
  ein Ordner-Feld (Einfügen, `"C:\…"`, `~`); leer heißt Benutzerordner. Gibt es den Ordner beim
  Wiederholen nicht mehr, startet das Fenster im Benutzerordner und der Hinweis sagt es.
- **Programm darin:** Läuft Claude Code im Fenster, merkt sich das der Workspace (am Fenstertitel
  erkannt); im Dialog lässt sich Claude, Codex, OpenCode oder „nur die Shell“ wählen.
- **Gespräch fortsetzen** (Häkchen je Workspace): Claude startet mit `--continue`, Codex mit
  `resume --last`, OpenCode mit `--continue`, jeweils das letzte Gespräch in diesem Ordner.
- Ein **benannter** Platz nimmt nur die Session mit genau diesem Namen; unbenannte Plätze finden ihre
  Session wie bisher über Programm und Titel.
- **Sicherheit:** Shell und Agenten-CLI werden mit ihrem vollen Pfad aus dem PATH gestartet, nie mit
  dem bloßen Namen (sonst würde eine gleichnamige Datei im Workspace-Ordner zuerst laufen). Ein
  gestartetes Fenster wird nur eingefangen, wenn es nachweislich aus diesem Start stammt (klassische
  Konsole: über ihren Elternprozess; Windows Terminal: über den gegebenen Namen; ohne Namen nimmt
  der Organizer das nächste neue Windows-Terminal-Fenster).

*English:* a workspace also keeps names, colours and folders; applying it reopens missing windows
(tiles, classic consoles, own Windows Terminal windows) in their folder and captures them.

## Agenten und Orchestrator

**Agent starten** (Titelleiste) öffnet Claude Code, Codex, OpenCode, die Eingabeaufforderung oder
PowerShell als Kachel direkt im Organizer, in allen Ansichten, mit Dock und Badge wie jede Session.
Nur Programme, die auf dem Rechner gefunden werden, sind wählbar.

- **Mutterprompt:** Jeder gestartete KI-Agent bekommt einen kurzen Rollentext (Claude als
  Systemprompt, Codex und OpenCode als erste Nachricht; eine normale Kachel ohne Aufgabe startet
  still, ohne Modellaufruf; ihre Regeln stehen auch in den Werkzeugbeschreibungen). Eigene Texte:
  `%APPDATA%\CLI Organizer\prompts\agent.md` (normale Kachel), `orchestrator.md` und `worker.md`.
- **Jede KI-Kachel kennt den Organizer:** Claude, Codex und OpenCode bekommen (als „Normal“ wie als
  „Orchestrator“) den MCP-Server `clio` mit `list_sessions`, `spawn_worker`, `send`, `send_keys`,
  `read_screen`, `read_tail`, `wait_for_idle`, `wait_for`, `stop_worker`. Fragst du „was kannst du?“,
  schaut der Agent zuerst nach; sagst du „öffne Codex und frag ihn …“, erscheint Codex als Kachel
  daneben (nie versteckt in einer Shell). **Normal** arbeitet selbst und holt sich bei Bedarf Hilfe;
  **Orchestrator** verteilt deine Aufgabe von Anfang an auf Worker.
- **Rechte (vom Organizer erzwungen, nicht vom Prompt):** Eine Kachel liest und tippt nur in ihre
  eigenen Worker und in Kacheln, die du mit **Für KI-Kacheln freigeben** markierst; beenden kann sie
  nur eigene Worker; höchstens 8 gleichzeitig. Worker und Shell-Kacheln bekommen keine MCP-Werkzeuge.
  Tippst du `claude` selbst in eine PowerShell-Kachel oder ein eingefangenes Fenster, bekommt es
  nichts davon, denn der Organizer hat dieses Programm nicht gestartet.
- **Protokoll:** Jede Eingabe einer KI-Kachel in eine andere steht in `%APPDATA%\CLI Organizer\agent-audit.log`
  (Secrets geschwärzt, rotiert bei 1 MB).
- **Schließen** des Organizers beendet gestartete Agenten (die App fragt vorher). Eingefangene
  Terminals laufen dagegen weiter.

*English:* **Start agent** opens Claude Code, Codex, OpenCode or a shell as a tile. Every AI tile
(plain or **Orchestrator**) gets the `clio` MCP tools to open other agents as tiles and drive and read
them: only its own workers and tiles you unlock for AI tiles; everything they type is logged in
`agent-audit.log`. Workers and shell tiles get no tools.

## Was garantiert ist, und wie es geprüft wird

- **Kein Terminal geht verloren.** Vor jeder Änderung an einem Fenster wird sein Originalzustand
  in ein Journal pro Instanz geschrieben (`%APPDATA%\CLI Organizer\restore-journal-<pid>-<start>.json`). Beim Schließen der App kommt alles
  zurück; stürzt sie ab, stellt ein Watchdog (PowerShell) alles wieder her; bleibt trotzdem etwas
  übrig, holt es der nächste App-Start zurück.
- **Mehrere Instanzen stören sich nicht.** Jede Instanz hat ihr eigenes Journal und ihren eigenen
  Watchdog. Ein Start stellt nur Journale beendeter Instanzen wieder her; ein Fenster, das eine
  andere Instanz hält, wird nie direkt eingefangen: **Übernehmen** bittet die andere Instanz, es
  freizugeben (es bekommt sein Original zurück), und fängt es erst danach ein. Der eingefangene
  Zustand einer anderen Instanz landet so nie als „Original“ im Journal. Fenster einer älteren Version (vor Mehrfach-Instanzen) müssen
  dort freigegeben werden; deren Journal bleibt unangetastet.
- **Dialoge liegen immer oben.** Solange „Terminal einfangen“ oder „Workspaces“ offen ist, liegen
  alle Terminals hinter der App; kommt eines nach vorn, wird es sofort wieder dahinter gelegt.
- **Ein hängendes Terminal friert die App nicht ein.** Alle Aufrufe, die ein fremdes Fenster ändern,
  laufen in einem Worker-Thread, höchstens einer pro Fenster.
- Geprüft durch: Unit-Tests, Integrationstests mit echten conhost- und Windows-Terminal-Fenstern,
  einen Selbsttest in der echten App (Ansichten, Z-Reihenfolge, Minimieren, Dock, Badge, Freigeben)
  und End-to-End-Tests, die die App normal schließen und hart beenden (`taskkill /F`) und danach
  bei jedem Fenster Stil, Rahmen-Stil, Besitzer, Sichtbarkeit und Position mit dem Original
  vergleichen, gegen die gebaute Exe.

## Grenzen

- **Als Administrator gestartete Terminals** lassen sich nur einfangen, wenn CLI Organizer ebenfalls
  als Administrator läuft (Windows-Sicherheitsgrenze UIPI). Die App sagt das in einem Hinweis.
- **Windows Terminal** wird als ganzes Fenster eingefangen, mit allen Tabs. Öffnet Windows Terminal
  neue Konsolen als Tab in einem bereits eingefangenen Fenster, landen sie dort. Wer das nicht will:
  in den Windows-Terminal-Einstellungen „Neue Instanz" auf „In neuem Fenster öffnen" stellen.
- Das Badge liest keinen Text, nur Titel und Bild. Es unterscheidet bei Nicht-Claude-Terminals nicht
  zwischen „fertig" und „braucht Eingabe": Beides heißt: der Agent wartet.
- Der Watchdog braucht Windows PowerShell mit erlaubter Skriptausführung für diesen einen Prozess
  (`-ExecutionPolicy Bypass`). Verbietet eine Gruppenrichtlinie das, übernimmt der nächste App-Start
  die Wiederherstellung.
- Die portable Exe ist nicht signiert; Windows SmartScreen kann beim ersten Start nachfragen.
- Wird ein eingefangenes Terminal bei offenem Dialog nach vorn geholt, legt die App es sofort hinter
  sich, die Tastatur kann aber bei ihm bleiben (Windows-Vordergrundsperre). Ein Klick in den Dialog
  holt sie zurück.
- **Orchestrator-Sicherheit:** Die Grenze ist dein Windows-Benutzer. Das Zugangs-Token des
  Orchestrators steht in keiner Kommandozeile (Datei bzw. Umgebung) und gilt für genau eine
  Verbindung. Aber ein Programm, das unter deinem Benutzer läuft, kann grundsätzlich alles, was du
  kannst. Gib Kacheln nur frei, deren Inhalt ein Agent lesen darf.
- **Workspaces öffnen neu, sie holen nichts zurück:** Verlauf und Ausgabe eines Terminals kommen
  nicht wieder; das Programm startet frisch (bei KI-CLIs optional im letzten Gespräch). PowerShell
  meldet beim `cd` keinen neuen Prozessordner; zurück kommt ihr **Startordner** (cmd liefert den
  aktuellen). Ein Windows Terminal mit mehreren Tabs kommt als ein Fenster zurück. Läuft ein
  gespeichertes Fenster nach dem Schließen des Organizers noch (freigegeben, nicht geschlossen),
  öffnet das Anwenden trotzdem ein neues. Also erst einfangen, dann anwenden.
- **Claude Code fragt in jedem neuen Ordner zuerst „Trust this folder?“**. Vorausgewählt ist
  „No, exit“. Startet eine Kachel einen Claude-Worker **in ihrem eigenen Ordner oder darunter**,
  beantwortet der Organizer die Frage selbst mit „Yes“ (steht im `agent-audit.log`). In jedem anderen
  Ordner und bei Kacheln, die du selbst startest, entscheidest du: Pfeiltasten auf „Yes“, dann Enter.

## Protokolle

`%APPDATA%\CLI Organizer\watchdog.log` (alle Instanzen): jeder Start des Watchdogs und was er nach dem Ende der App getan hat.

## Entwicklung

```bash
npm install
npm run dev          # App mit Hot Reload
npm test             # Unit-Tests
npm run test:win     # Integrationstests mit echten Konsolenfenstern (öffnet und schließt Testfenster)
npm run build        # Bundles nach out/
npm run test:e2e     # Selbsttest + Schließen + harter Kill gegen die App (APP_EXE=… für die Exe)
npm run dist         # portable Exe nach dist/
```

Design-Vorschau ohne Electron (Beispieldaten, nur für den Design-Nachweis):
`npx vite --config vite.preview.config.ts` → `http://localhost:5199/preview.html`
(`?lang=en`, `?view=grid|free|tabs`, `?dock=1`, `?dialog=picker|workspaces`, `?empty=1`, `?notice=1`).

## Lizenz

[FSL-1.1-MIT](LICENSE.md), die Functional Source License. Einfach gesagt: frei nutzen, ändern und
weitergeben, nur kein konkurrierendes kommerzielles Produkt daraus bauen. Zwei Jahre nach jeder
Version gilt für diese Version die MIT-Lizenz. Verbindlich ist der Lizenztext.
