// functions/google-auth-helper.js
// Validador de tokens de acceso de Google.
// Reemplaza al antiguo auth-helper.js estático.

/**
 * Verifica un token de acceso de Google contra el endpoint tokeninfo.
 * @param {object} event - El evento de la función de Netlify.
 * @returns {Promise<boolean>} - Verdadero si el token es válido y coincide con nuestro Client ID.
 */
async function validateGoogleToken(event) {
  const token = event.headers.authorization?.split(' ')[1];
  
  // 1. Verificar si el token existe
  if (!token) {
    console.warn("Auth Error: No se proporcionó token.");
    return false;
  }

  const expectedAudience = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!expectedAudience) {
    console.error("Auth Error: GOOGLE_OAUTH_CLIENT_ID no está configurado en el servidor.");
    return false; // Error de configuración
  }

  try {
    // 2. Consultar al endpoint tokeninfo de Google
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    const data = await response.json();

    if (!response.ok) {
      console.warn("Auth Error: Token inválido o expirado.", data.error_description || data.error);
      return false;
    }

    // 3. **Verificación de Audiencia (CRUCIAL)**
    // Esto asegura que el token fue emitido para *nuestra* aplicación.
    if (data.aud !== expectedAudience) {
      console.warn(`Auth Error: Discrepancia de audiencia. Esperada: ${expectedAudience}, Recibida: ${data.aud}`);
      return false;
    }

    // 4. (Opcional) Podemos adjuntar la info del usuario al evento para usarla después
    event.user = { email: data.email, id: data.sub };

    // 5. El token es válido y es para nosotros.
    return true;

  } catch (error) {
    console.error("Error en la validación del token:", error);
    return false;
  }
}

module.exports = { validateGoogleToken };
