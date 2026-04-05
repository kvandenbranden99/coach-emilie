/**
 * Eenmalige Google OAuth2 flow om een refresh token te verkrijgen voor Google Calendar.
 * Gebruik: npm run auth:google
 *
 * Vereiste: credentials.json in de projectroot (gedownload via Google Cloud Console)
 * Resultaat: GOOGLE_REFRESH_TOKEN wordt opgeslagen in .env
 *
 * Voeg http://localhost:3000/callback toe als authorized redirect URI
 * in Google Cloud Console > APIs & Services > Credentials > [jouw OAuth client]
 */

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const ENV_PATH = path.join(__dirname, '..', '.env');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

function updateEnvFile(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, content);
  console.log(`✓ ${key} opgeslagen in .env`);
}

async function main() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('Fout: credentials.json niet gevonden in de projectroot.');
    console.error('Download het bestand via Google Cloud Console > APIs & Services > Credentials > [jouw OAuth client] > Download JSON');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const creds = raw.installed || raw.web;

  if (!creds) {
    console.error('Fout: ongeldig credentials.json formaat. Verwacht "installed" of "web" sleutel.');
    process.exit(1);
  }

  const { client_id: clientId, client_secret: clientSecret } = creds;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/callback') {
        res.end('Niet gevonden.');
        return;
      }

      const code = parsed.query.code;
      const error = parsed.query.error;

      if (error) {
        res.end(`<h2>Authenticatie geannuleerd: ${error}</h2>`);
        server.close();
        return reject(new Error(`OAuth fout: ${error}`));
      }

      if (!code) {
        res.end('<h2>Geen autorisatiecode ontvangen.</h2>');
        server.close();
        return reject(new Error('Geen code ontvangen'));
      }

      res.end('<h2>Authenticatie geslaagd! Je kunt dit venster sluiten.</h2>');
      server.close();

      try {
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.refresh_token) {
          console.error('Fout: geen refresh token ontvangen.');
          console.error('Verwijder app-toegang via myaccount.google.com/permissions en voer het script opnieuw uit.');
          return reject(new Error('Geen refresh token in respons'));
        }

        updateEnvFile('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Lokale server gestart op poort ${REDIRECT_PORT}`);
      console.log('Browser openen voor Google authenticatie...\n');
      exec(`open "${authUrl}"`);
      console.log(`Als de browser niet opent, ga dan handmatig naar:\n${authUrl}\n`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Poort ${REDIRECT_PORT} is al in gebruik. Stop het andere proces en probeer opnieuw.`);
      }
      reject(err);
    });
  });
}

main()
  .then(() => {
    console.log('\nGoogle OAuth flow voltooid.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFout tijdens authenticatie:', err.message);
    process.exit(1);
  });
