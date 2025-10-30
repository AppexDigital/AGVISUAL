// functions/auth-google.js
// Intercambia un código de autorización por tokens de acceso y actualización
// ACTUALIZADO: para recibir la redirectUri dinámica desde el frontend

const { google } = require('googleapis');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { code, redirectUri } = JSON.parse(event.body);
  if (!code || !redirectUri) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan parámetros: "code" y "redirectUri" son requeridos.' }) };
  }

  try {
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri // Usar la URI exacta que usó el frontend
    );

    // Intercambia el código por tokens
    const { tokens } = await oAuth2Client.getToken(code);
    
    // tokens contendrá: access_token, refresh_token, expiry_date, scope, token_type
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens),
    };

  } catch (error) {
    console.error('Error al intercambiar el código por tokens:', error.response?.data || error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al autenticar con Google.', details: error.response?.data || error.message }),
    };
  }
};



