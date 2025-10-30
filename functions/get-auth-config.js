// functions/get-auth-config.js
// NUEVA FUNCIÓN PÚBLICA
// Provee de forma segura la configuración pública (el Client ID) al frontend.
// Esto evita "hardcodear" el Client ID en el archivo HTML.

exports.handler = async (event, context) => {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    console.error("Error de Configuración: GOOGLE_OAUTH_CLIENT_ID no está definido en Netlify.");
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error de configuración del servidor [Auth Cfg].' }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    }),
  };
};
