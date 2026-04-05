# Coach Emilie — Persoonlijke AI Coach Agent

Een proactieve AI-coach die je dagelijks herinnert aan gewoonten en wekelijks incheckt via Telegram en Slack.

## Functionaliteiten

- **Dagelijkse herinneringen** voor gewoonten op vrije momenten in je agenda
- **Slimme kanaalrouting**: Slack tijdens kantooruren (ma–vr 09:00–17:00), Telegram voor de rest
- **Agendaintegratie**: Google Calendar + Microsoft Outlook (herinneringen worden gepland op vrije momenten)
- **Herhalingslogica**: automatisch opnieuw proberen bij geen reactie of weigering
- **Wekelijkse vrijdagsessie** om 13:00 via Telegram (rapport + reflectie + to-do's)
- **Gewoontenbeheer via chat**: toevoegen, pauzeren, verwijderen in gewone taal

## Berichtenkanalen

| Moment | Dag | Kanaal |
|--------|-----|--------|
| 09:00 – 17:00 | Weekdagen (ma–vr) | Slack |
| 08:00 – 09:00 | Weekdagen | Telegram |
| 17:00 – 23:00 | Weekdagen | Telegram |
| 08:00 – 23:00 | Weekend | Telegram |
| 13:00 (vrijdagsessie) | Vrijdag | Altijd Telegram |

## Vereisten

- Node.js 18+
- Anthropic API-sleutel
- Telegram bot token
- (optioneel) Slack bot tokens
- (optioneel) Google Calendar credentials
- (optioneel) Microsoft Outlook credentials

## Installatie

```bash
cd coach-emilie
npm install
cp .env.example .env
# Vul .env in met jouw gegevens
npm run setup   # Initialiseer de database
npm start
```

Voor lokale ontwikkeling:
```bash
npm run dev     # Herstart automatisch bij wijzigingen
```

---

## Setup per integratie

### 1. Telegram Bot

1. Open Telegram en zoek **@BotFather**
2. Stuur `/newbot` en volg de instructies
3. Kopieer het bot token naar `.env` → `TELEGRAM_BOT_TOKEN`
4. Start een gesprek met je nieuwe bot
5. Haal je persoonlijke chat-ID op via **@userinfobot**
6. Vul het in → `TELEGRAM_CHAT_ID`

### 2. Slack Bot (optioneel)

1. Ga naar [api.slack.com/apps](https://api.slack.com/apps) en klik **Create New App → From Scratch**
2. Geef de app een naam en kies je workspace
3. Ga naar **Socket Mode** en activeer dit; genereer een App-Level Token (scope: `connections:write`) → `SLACK_APP_TOKEN`
4. Ga naar **OAuth & Permissions** en voeg toe aan *Bot Token Scopes*: `chat:write`, `channels:history`, `im:history`, `im:write`
5. Installeer de app in je workspace → kopieer het Bot Token → `SLACK_BOT_TOKEN`
6. Kopieer de **Signing Secret** (onder *Basic Information*) → `SLACK_SIGNING_SECRET`
7. Ga naar **Event Subscriptions → Subscribe to bot events** en voeg toe: `message.channels`, `message.im`
8. Voeg de bot toe aan het gewenste kanaal en kopieer het kanaal-ID → `SLACK_CHANNEL_ID`

### 3. Google Calendar (optioneel)

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com)
2. Maak een nieuw project aan
3. Activeer de **Google Calendar API**
4. Ga naar *Credentials → Create Credentials → OAuth 2.0 Client ID* (type: Desktop)
5. Kopieer Client ID en Secret → `.env`
6. Voer de OAuth-flow uit om een refresh token te verkrijgen:

```bash
node -e "
const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
);

const url = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/calendar.readonly']
});

console.log('Bezoek deze URL:', url);

const rl = readline.createInterface({ input: process.stdin });
rl.question('Voer de code in: ', async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
  rl.close();
});
"
```

### 4. Microsoft Outlook (optioneel)

1. Ga naar [portal.azure.com](https://portal.azure.com) → **Azure Active Directory → App registrations → New registration**
2. Kies *Accounts in any organizational directory and personal Microsoft accounts*
3. Voeg een **Redirect URI** toe: `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Ga naar **Certificates & secrets → New client secret** → kopieer naar `MICROSOFT_CLIENT_SECRET`
5. Ga naar **API permissions → Add permission → Microsoft Graph → Delegated → Calendars.Read**
6. Kopieer de Application (client) ID → `MICROSOFT_CLIENT_ID`
7. Haal een refresh token op via de OAuth-flow (gebruik [Microsoft OAuth Playground](https://oauthplaygound.azurewebsites.net/) of Postman)

---

## Omgevingsvariabelen

Zie `.env.example` voor een volledige lijst. De verplichte variabelen zijn:

| Variabele | Beschrijving |
|-----------|--------------|
| `ANTHROPIC_API_KEY` | Jouw Anthropic API-sleutel |
| `TELEGRAM_BOT_TOKEN` | Token van @BotFather |
| `TELEGRAM_CHAT_ID` | Jouw persoonlijke Telegram chat-ID |
| `USER_NAME` | Jouw naam (voor de coach-berichten) |

---

## Gewoontenbeheer via chat

Je beheert gewoonten gewoon door te chatten met de bot:

```
"Ik wil een nieuwe gewoonte toevoegen"
"Verwijder de gewoonte ademhaling"
"Pauzeer mijn stappengewoonte"
"Welke gewoonten heb ik actief?"
"Hervat mijn leesgewoonte"
```

---

## Vrijdagsessie

Elke vrijdag om 13:00 start de bot automatisch een gestructureerde check-in via Telegram:

1. Begroeting + weekrapport gewoonten
2. Reflectie: wat ging goed / wat was moeilijk
3. Bespreking openstaande to-do's
4. Nieuwe to-do's voor komende week
5. Dankbaarheidsmoment
6. Samenvatting

Typ `klaar` of `stop` om de sessie te beëindigen.

---

## Deployment op Railway of Render

1. Push de code naar GitHub
2. Verbind Railway/Render met je repository
3. Stel de omgevingsvariabelen in via het dashboard
4. De health check endpoint is beschikbaar op `GET /health`
5. Voeg een **persistent disk** toe voor de SQLite database (pad: `/data`)

---

## Projectstructuur

```
src/
├── index.js            # Startpunt
├── scheduler.js        # Cron jobs
├── coach.js            # Claude AI logica
├── channelRouter.js    # Telegram vs. Slack routing
├── telegram.js         # Telegram bot
├── slack.js            # Slack bot
├── habitManager.js     # Gewoontenbeheer via gesprek
├── messageHandler.js   # Centrale berichtverwerking
├── state.js            # In-memory gespreksstate
├── calendar/
│   ├── index.js        # Vrije-slot berekening
│   ├── google.js       # Google Calendar API
│   └── outlook.js      # Microsoft Outlook API
├── database/
│   ├── db.js           # SQLite verbinding
│   └── migrations.js   # Schema + initiële data
└── config/
    └── habits.js       # Initiële gewoonten
```
