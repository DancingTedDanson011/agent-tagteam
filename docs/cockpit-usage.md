# Projekt-Cockpit benutzen

Das Cockpit ist über die Navigation „Cockpit“ erreichbar, auch ohne eingefangene Fenster. „Projekt hinzufügen“ wählt einen bestehenden Ordner. Erkannte Claude-Sessions werden ihrem Projekt automatisch zugeordnet; Unterordner eines Git-Repositories gehören zum selben Projekt.

Die Übersicht zeigt Projekte und „Wartet auf dich“. „Zur Kachel“ öffnet eine eindeutig zugeordnete Kachel. Sessions außerhalb des Organizers bleiben sichtbar; eine unsichere Prozesszuordnung erhält keine Fokusaktion.

Das Board ergänzt manuelle Aufgaben und Vertragsentwürfe. Der Status importierter Aufgaben bleibt in ihrer Quelldatei maßgeblich. Details zeigen Kriterien, Nachweise, beobachtete Zeit, Quellenzustand und Ereignisse.

## Einen Vertrag prüfen

Ein Entwurf hält Ziel, Budget und Prüfkommando fest. Vor „Einfrieren“ den vollständigen Vertrag und seine Kommandos prüfen. Diese Freigabe ist lokal gespeichert; eine Datei aus einem anderen Repository kann sich keine Ausführungsfreigabe selbst geben.

Nach dem Einfrieren können automatisierte Kriterien ausgeführt werden. Windows-Kommandos laufen über die System-cmd im Projektordner. Ausgaben werden begrenzt und Zugangsdaten maskiert. Prüfläufe sind abbrechbar und haben ein Zeitlimit. Der Nachweis enthält den tatsächlichen Exitstatus und den geprüften Quellstand, bei Git auch HEAD.

Manuelle Kriterien erfordern eine ausdrückliche Bestätigung im Cockpit. Ein grüner älterer Lauf ersetzt keinen fehlgeschlagenen, laufenden oder veralteten Nachweis. Ändert sich die Definition, ist eine Änderung mit erneuter Freigabe nötig. Ändert sich eine relevante Projektdatei, verlieren vorhandene Nachweise ihre Aktualität. Nicht unterstützte Dateigrenzen oder überschrittene Leselimits verhindern eine vollständige Quellstandbestätigung.

Die Zielschleife lässt sich als Text kopieren. Agenten mit Organizer-MCP können eigene Verträge lesen und Checks anstoßen; Einfrieren und manuelle Bestätigungen bleiben in der Oberfläche.

## Quellen und optionales Plugin

Die Session-Registry wird lokal gelesen. Unbekannte Versionen und ungültige Eingaben werden sichtbar gemeldet. Für detaillierte Fragen und Werkzeugereignisse stellt die App ein optionales Claude-Plugin dauerhaft unter `cockpit-plugin` im App-Datenordner bereit; „Details“ zeigt den vollständigen Pfad. Dieser bleibt auch nach dem Schließen der portablen App verfügbar. Die App registriert das Plugin nicht in Claude und ändert keine Claude-Einstellungen. Eine neue Claude-Sitzung kann es ausdrücklich mit `claude --plugin-dir "<angezeigter Plugin-Pfad>"` laden. Das Plugin beobachtet und schreibt lokal; es trifft keine Guard-Entscheidungen.

Bestehende Code-Guardian-Artefakte werden optional gelesen, einschließlich alter und neuer Todo-Grammatik. Nicht vorhandene Quellen sind als fehlend erkennbar. Die Quelle bleibt Eigentümerin ihres Status.

Reale Permission-, Question- und Plan-Hookabläufe der lokalen Claude-Installation sind weiterhin manuell zu prüfen. Parsertests und Desktop-Selbsttests verwenden dafür synthetische Daten; daraus folgt keine Abnahme der ursprünglichen Spike-Kriterien. Die vorhandenen Phasenverträge bleiben Entwürfe.

## Lokale Daten und Grenzen

Die Daten liegen im Electron-Benutzerdatenordner in `cockpit.db`; `cockpit.lock` koordiniert den Schreiber. Weitere Organizer-Instanzen lesen mit und übernehmen nach Ende des Schreibers. Kachelzuordnungen werden je Instanz aus deren eigenen Prozessen ermittelt.

Budgets zeigen zugeordnete Sessions und tatsächlich beobachtete aktive Zeit. Kosten werden nicht geschätzt. Automatisches Starten von Agenten aus Verträgen und Fernzugriff sind nicht enthalten.
