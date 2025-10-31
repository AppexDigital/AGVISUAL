// functions/upload-image.js
// v2.1 - ARQUITECTURA DE DELEGACIÓN OAUTH (TOKEN DE USUARIO)
// Esta versión usa el access_token del usuario (que ahora tendrá el scope 'drive.file')
// para realizar la subida, usando la cuota de almacenamiento del usuario.

const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');
// Importamos el validador de token del usuario
const { validateGoogleToken } = require('./google-auth-helper');

// Helper para parsear el form data (usando busboy)
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({
        headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] }
      });
      const fields = {};
      const files = {};
      const tmpdir = os.tmpdir();

      busboy.on('field', (fieldname, val) => {
        fields[fieldname] = val;
      });

      busboy.on('file', (fieldname, file, { filename, encoding, mimeType }) => {
        const filepath = path.join(tmpdir, `busboy-upload-${Date.now()}-${filename}`);
        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);

        file.on('end', () => {
          files[fieldname] = {
            filepath,
            filename,
            mimeType,
            encoding,
          };
        });
      });

      busboy.on('close', () => resolve({ fields, files }));
      busboy.on('error', err => reject(err));

      // Decodificar el body si es base64
      const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');
      busboy.end(bodyBuffer);

    } catch (error) {
      reject(error);
    }
  });
}

// --- Handler Principal ---
exports.handler = async (event, context) => {
  // 1. **SEGURIDAD:** Validar el token de acceso del USUARIO.
  // Esto no solo valida que es un usuario logueado, sino que el token
  // que nos pasa es el que usaremos para la subida.
  if (!(await validateGoogleToken(event))) {
    return {
      statusCode: 401, // No autorizado
      body: JSON.stringify({ error: 'No autorizado. Token de Google inválido o expirado.' }),
    };
  }
  
  // Extraer el Token de Usuario (Access Token de Google)
  const userAccessToken = event.headers.authorization.split(' ')[1];

  // 2. Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const parentFolderId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
  if (!parentFolderId) {
      console.error("Error: GOOGLE_DRIVE_ASSET_FOLDER_ID no está configurado.");
      return { statusCode: 500, body: JSON.stringify({ error: 'Configuración del servidor incompleta [Drive Folder ID]' }) };
  }

  let tempFilePath = null;

  try {
    // 3. Parsear el Form Data (usando busboy)
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    const targetSubfolder = fields.targetSubfolder || 'general';

    if (!file) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se recibió ningún archivo (key="file").' }) };
    }
    
    tempFilePath = file.filepath; // Guardar ruta para limpieza

    // 4. *** INICIO DEL AJUSTE DE CIRUJANO v9.0 ***
    // Crear Cliente OAuth2 y Drive Service (usando el TOKEN DE USUARIO)
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    // Establecer el token del usuario como credencial
    oAuth2Client.setCredentials({ access_token: userAccessToken });
    
    // Crear el servicio de Drive usando la autenticación del USUARIO
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });
    // *** FIN DEL AJUSTE DE CIRUJANO v9.0 ***

    // 5. Buscar o crear la subcarpeta
    let targetFolderId = parentFolderId;
    if (targetSubfolder && targetSubfolder !== 'general') {
        const folderQuery = `mimeType='application/vnd.google-apps.folder' and name='${targetSubfolder}' and '${parentFolderId}' in parents and trashed = false`;
        const folderRes = await drive.files.list({ q: folderQuery, fields: 'files(id)', spaces: 'drive' });

        if (folderRes.data.files && folderRes.data.files.length > 0) {
            targetFolderId = folderRes.data.files[0].id;
        } else {
            const folderMetadata = {
                name: targetSubfolder,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentFolderId]
            };
            const createdFolder = await drive.files.create({
                resource: fileMetadata,
                fields: 'id'
            });
            targetFolderId = createdFolder.data.id;
        }
    }

    // 6. Preparar metadatos y media
    const fileMetadata = {
      name: file.filename || `upload_${Date.now()}`,
      parents: [targetFolderId]
    };
    const media = {
      mimeType: file.mimeType,
      body: fs.createReadStream(tempFilePath),
    };

    // 7. Subir el archivo
    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name',
    });
    
    const fileId = driveResponse.data.id;

    // 8. Hacer público
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // 9. Obtener metadatos
     const updatedFile = await drive.files.get({
       fileId: fileId,
       fields: 'webViewLink, webContentLink',
     });

    // 10. Devolver URL
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
          message: 'Archivo subido con éxito.',
          fileId: fileId,
          fileName: driveResponse.data.name,
          // Usar 'preview' es más robusto para <img src>
          imageUrl: updatedFile.data.webViewLink.replace('/view', '/preview') 
      }),
    };

  } catch (error) {
    console.error('Error subiendo archivo a Drive (v2.1 - Usuario):', error);
    
    // ESTE ES EL ERROR QUE ESTÁBAMOS VIENDO ANTES
    if (error.message && error.message.includes('insufficient authentication scopes')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Error de Permisos. El token del usuario no tiene el scope de "drive.file".', details: error.message })};
    }
    
    // Manejar errores de token inválido
    if (error.code === 401 || (error.response && error.response.status === 401)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Token de Google inválido o expirado.', details: error.message }) };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al subir el archivo.', details: error.message }),
    };
  } finally {
      // 11. Limpiar
      if (tempFilePath) {
        try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Error limpiando archivo temporal:", e); }
      }
  }
};

