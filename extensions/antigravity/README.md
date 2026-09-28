# pi-antigravity

Estensione provider e agent adapter per [pi](https://github.com/earendil-works/pi) che integra **Google Antigravity** utilizzando la propria sottoscrizione Google senza violare i Terms of Service (ToS).

---

## 1. Come T3 Code evita di violare i ToS di Google Antigravity

Molti client di terze parti violano i Termini di Servizio dei provider AI perché:
1. Fanno reverse-engineering di endpoint web privati o non documentati (es. scraping di sessioni web con cookie rubati dal browser).
2. Estraggono token crittografati in modo non autorizzato dalla memoria o dal database dell'IDE.
3. Fanno scraping automatizzato simulando un utente reale per aggirare captcha o controlli anti-bot.
4. Creano proxy multi-tenant remoti per rivendere o condividere quote di abbonamenti personali.

### Come fa T3 Code:
T3 Code adotta un approccio **100% conforme e legale**, basato su quattro pilastri:

1. **Protocollo Ufficiale ACP (Agent Client Protocol)**:
   - Google partecipa attivamente allo standard aperto **ACP** (Agent Client Protocol) registrato pubblicamente nel repository [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json).
   - In tale registro, Google distribuisce ufficialmente gli eseguibili headless compilati per macOS, Linux e Windows (`agy_acp_server` e `localharness_external`) ospitati direttamente sul CDN di Google (`https://dl.google.com/agy-extensions/releases/...`).
   - L'eseguibile è stato creato da Google espressamente per consentire ad ambienti client e harness esterni di interagire con Antigravity via JSON-RPC standard.

2. **Flusso di Autenticazione Ufficiale (BYOK / BYO-Subscription)**:
   - T3 Code non ruba le credenziali dall'Antigravity IDE o da Chrome.
   - Quando `agy_acp_server` viene avviato, è lo stesso binario di Google a richiedere l'autenticazione OAuth 2.0 (`https://accounts.google.com/o/oauth2/v2/auth`).
   - L'utente apre il link nel proprio browser ed effettua l'accesso col proprio account Google personale o Gemini Enterprise, con reindirizzamento locale su `http://127.0.0.1:<port>/`.
   - Il token viene conservato in un profilo isolato (`GEMINI_HOME/antigravity-acp/acp_token.json`).

3. **Esecuzione Locale come Subprocesso (Nessun Proxy o Rivendita)**:
   - Il binario gira esclusivamente in locale sul computer dell'utente come processo figlio.
   - Nessun dato passa attraverso server proxy centrali.
   - Tutte le chiamate vengono conteggiate direttamente sulla quota dell'account dell'utente, rispettando i limiti di abbonamento (`SUBSCRIPTION_REQUIRED`) e i filtri di sicurezza di Google.

---

## 2. Come funziona questa estensione per Pi Agent

Questa estensione applica la medesima architettura trasparente e lecita a **Pi Agent**:

1. **Rilevamento del Binario Ufficiale Locale**:
   - Rileva automaticamente l'eseguibile ufficiale Google Antigravity (`agy.exe` presente in `~/.gemini/bin/agy.exe` o nel `PATH`), oppure il runtime gestito ACP (`agy_acp_server`).
2. **Esecuzione Non-Interattiva Streaming (NDJSON)**:
   - Quando Pi invia una richiesta tramite il provider `antigravity`, l'estensione invoca l'eseguibile ufficiale locale in modalità headless con `--output-format stream-json`.
   - Il prompt viene passato tramite `stdin` (senza limiti di lunghezza su riga di comando).
   - I chunk di testo (`text_delta`) e il consumo di token (`input_tokens`, `output_tokens`, `thinking_tokens`) vengono decodificati in tempo reale dallo standard output ed emessi nello stream di Pi (`AssistantMessageEventStream`).
3. **Connessione con l'Account Esistente**:
   - Sfrutta la sessione già autenticata in locale sulla macchina dell'utente, senza bisogno di estrarre né salvare chiavi API in chiaro.

---

## 3. Funzionalità

- **Provider `antigravity`**:
  - Seleziona un modello con `/model antigravity/<id>` in Pi.
  - Streaming in tempo reale di risposte e codice.
  - Conteggio trasparente di token e token di ragionamento (*thinking tokens*).
  - Cancellazione pulita su `Ctrl+C` o abort signal (terminazione del processo figlio).
- **Scoperta Dinamica dei Modelli**:
  - Interroga direttamente `agy models` per ottenere la lista sempre aggiornata dei modelli abilitati sul tuo account Google.
  - Include modelli ad alto ragionamento come `gemini-3.8-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6` e `gpt-oss-120b-medium`.
- **Comando `/antigravity`**:
  - `/antigravity status` — Verifica lo stato dell'eseguibile e l'autenticazione con Google.
  - `/antigravity models` — Mostra la lista dei modelli disponibili.
  - `/antigravity test` — Esegue un turno di test per confermare la connessione.
  - `/antigravity task <prompt>` — Esegue un task completo di Antigravity nello spazio di lavoro corrente.
- **Tool `antigravity_task`**:
  - Tool per l'LLM di Pi per delegare compiti complessi di programmazione o refactoring ad Antigravity.

---

## 4. Installazione e Configurazione

L'estensione è già installata nella directory globale delle estensioni di Pi:

```
~/.pi/agent/extensions/antigravity/
```

### Ricaricare Pi
In una sessione attiva di Pi, esegui:
```
/reload
```
oppure riavvia `pi`.

### Verificare l'installazione
In Pi, digita:
```
/antigravity status
```

Per selezionare un modello Antigravity in Pi:
```
/model
```
e seleziona ad esempio `antigravity/gemini-3.8-flash-high`.
