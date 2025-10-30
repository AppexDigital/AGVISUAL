// functions/auth-refresh.js
// Refresca un access_token expirado usando un refresh_token
// (Sin cambios, pero se incluye para integridad)

const { google } = require('googleapis');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { refresh_token } = JSON.parse(event.body);
  if (!refresh_token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el refresh_token.' }) };
  }

  try {
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );

    oAuth2Client.setCredentials({ refresh_token: refresh_token });
    const { tokens } = await oAuth2Client.refreshAccessToken();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens),
    };

  } catch (error) {
    console.error('Error al refrescar el token:', error.response?.data || error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al refrescar el token.', details: error.response?.data || error.message }),
    };
  }
};


