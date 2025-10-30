// functions/upload-image.js
// v2.0 - PIVOTE A OAUTH 2.0 (TOKEN DE USUARIO)
// Utiliza el access_token del usuario (obtenido vía OAuth) para la autenticación de Drive.

const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy'); // Mantenemos busboy

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
  // 1. Verificar Autorización (¡NUEVO MÉTODO!)
  if (!event.headers.authorization || !event.headers.authorization.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado. Falta token de usuario.' }) };
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

    // 4. Crear Cliente OAuth2 y Drive Service (¡NUEVO MÉTODO!)
    const oAuth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    // Establecer el token del usuario como credencial
    oAuth2Client.setCredentials({ access_token: userAccessToken });
    
    // Crear el servicio de Drive usando la autenticación del USUARIO
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

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
                resource: folderMetadata,
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
          imageUrl: updatedFile.data.webViewLink.replace('/view', '/preview')
      }),
    };

  } catch (error) {
    console.error('Error subiendo archivo a Drive (v2.0):', error);
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



