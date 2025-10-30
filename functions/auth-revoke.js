// functions/auth-revoke.js
// Revoca un token de acceso (cierre de sesión)
// (Sin cambios, pero se incluye para integridad)

const { google } = require('googleapis');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const { token } = JSON.parse(event.body);
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el token a revocar.' }) };
  }

  try {
    const oAuth2Client = new google.auth.OAuth2();
    await oAuth2Client.revokeToken(token);
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Token revocado exitosamente.' }),
    };
  } catch (error) {
    console.error('Error al revocar el token:', error.response?.data || error.message);
    return {
      statusCode: 200, // Devolver 200 para que el logout funcione
      body: JSON.stringify({ message: 'Logout procesado.' }),
    };
  }
};