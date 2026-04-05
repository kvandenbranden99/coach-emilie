/**
 * Eenmalige Microsoft OAuth2 flow om een refresh token te verkrijgen voor Outlook/Microsoft Graph.
 * Gebruik: npm run auth:outlook
 *
 * Vereiste: MICROSOFT_CLIENT_ID en MICROSOFT_CLIENT_SECRET in .env
 * Optioneel: MICROSOFT_TENANT_ID in .env (standaard: "common")
 * Resultaat: MICROSOFT_REFRESH_TOKEN wordt opgeslagen in .env
 *
 * Voeg http://localhost:3001/callback toe als redirect URI in Azure Portal:
 * Azure Portal > App registrations > [jouw app] > Authentication > Add platform > Web
 */

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const fetch = require('node-fetch');
require('dotenv').config();

const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = 'Calendars.ReadWrite offline_access User.Read';
const ENV_PATH = path.join(__dirname, '..', '.env');

function getRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`Fout: ${key} ontbreekt in .env`);
    process.exit(1);
  }
  return value;
}

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
  const clientId = getRequiredEnv('MICROSOFT_CLIENT_ID');
  const clientSecret = getRequiredEnv('MICROSOFT_CLIENT_SECRET');
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
  });
  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/callback') {
        res.end('Niet gevonden.');
        return;
      }

      const code = parsed.query.code;
      const error = parsed.query.error;
      const errorDescription = parsed.query.error_description;

      if (error) {
        res.end(`<h2>Authenticatie geannuleerd: ${error}</h2><p>${errorDescription || ''}</p>`);
        server.close();
        return reject(new Error(`OAuth fout: ${error} - ${errorDescription}`));
      }

      if (!code) {
        res.end('<h2>Geen autorisatiecode ontvangen.</h2>');
        server.close();
        return reject(new Error('Geen code ontvangen'));
      }

      res.end('<h2>Authenticatie geslaagd! Je kunt dit venster sluiten.</h2>');
      server.close();

      try {
        const tokenResponse = await fetch(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              redirect_uri: REDIRECT_URI,
              grant_type: 'authorization_code',
            }),
          }
        );

        const data = await tokenResponse.json();

        if (data.error) {
          console.error('Token fout:', data.error_description || data.error);
          return reject(new Error(data.error));
        }

        if (!data.refresh_token) {
          console.error('Fout: geen refresh token ontvangen.');
          console.error('Controleer of "offline_access" in de scopes staat en of de app correct is geconfigureerd in Azure Portal.');
          return reject(new Error('Geen refresh token in respons'));
        }

        updateEnvFile('MICROSOFT_REFRESH_TOKEN', data.refresh_token);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Lokale server gestart op poort ${REDIRECT_PORT}`);
      console.log('Browser openen voor Microsoft authenticatie...\n');
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
    console.log('\nOutlook OAuth flow voltooid.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFout tijdens authenticatie:', err.message);
    process.exit(1);
  });
