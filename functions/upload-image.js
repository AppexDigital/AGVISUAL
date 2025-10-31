// functions/upload-image.js
// v3.0 - RE-ARQUITECTADO PARA USAR SERVICE ACCOUNT
// Valida el token de usuario (OAuth) pero usa el Service Account (JWT) para la subida.

const { google } = require('googleapis');
const { JWT } = require('google-auth-library'); // Importar JWT
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');
// Importamos nuestro validador de token
const { validateGoogleToken } = require('./google-auth-helper');

// Helper para parsear el form data (sin cambios)
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
// ... (código existente sin cambios) ...
    try {
      const busboy = Busboy({
        headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] }
      });
// ... (código existente sin cambios) ...
      const fields = {};
      const files = {};
      const tmpdir = os.tmpdir();

      busboy.on('field', (fieldname, val) => {
// ... (código existente sin cambios) ...
        fields[fieldname] = val;
      });

      busboy.on('file', (fieldname, file, { filename, encoding, mimeType }) => {
// ... (código existente sin cambios) ...
        const filepath = path.join(tmpdir, `busboy-upload-${Date.now()}-${filename}`);
        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);

        file.on('end', () => {
// ... (código existente sin cambios) ...
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
// ... (código existente sin cambios) ...
      const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');
      busboy.end(bodyBuffer);

    } catch (error) {
// ... (código existente sin cambios) ...
      reject(error);
    }
  });
}

// --- Handler Principal (v3.0) ---
exports.handler = async (event, context) => {
  // 1. **SEGURIDAD:** Verificar el token de Google del usuario (OAuth).
  if (!(await validateGoogleToken(event))) {
    return {
      statusCode: 401, // No autorizado
      body: JSON.stringify({ error: 'No autorizado. Token de Google inválido o expirado.' }),
    };
  }
  // Si llegamos aquí, el usuario es un admin autenticado.

  // 2. Solo permitir POST
  if (event.httpMethod !== 'POST') {
// ... (código existente sin cambios) ...
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const parentFolderId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
  if (!parentFolderId) {
// ... (código existente sin cambios) ...
      console.error("Error: GOOGLE_DRIVE_ASSET_FOLDER_ID no está configurado.");
      return { statusCode: 500, body: JSON.stringify({ error: 'Configuración del servidor incompleta [Drive Folder ID]' }) };
  }

  let tempFilePath = null;

  try {
    // 3. Parsear el Form Data (sin cambios)
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
// ... (código existente sin cambios) ...
    const targetSubfolder = fields.targetSubfolder || 'general';

    if (!file) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se recibió ningún archivo (key="file").' }) };
    }
    
    tempFilePath = file.filepath; // Guardar ruta para limpieza

    // 4. *** INICIO DEL AJUSTE DE CIRUJANO v8.0 ***
    // Crear Cliente de Autenticación del SERVICE ACCOUNT (Robot)
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/drive.file'], // El robot sí tiene este permiso
    });

    // Crear el servicio de Drive usando la autenticación del ROBOT
    const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });
    // *** FIN DEL AJUSTE DE CIRUJANO v8.0 ***

    // 5. Buscar o crear la subcarpeta (sin cambios)
    let targetFolderId = parentFolderId;
    if (targetSubfolder && targetSubfolder !== 'general') {
// ... (código existente sin cambios) ...
        const folderQuery = `mimeType='application/vnd.google-apps.folder' and name='${targetSubfolder}' and '${parentFolderId}' in parents and trashed = false`;
        const folderRes = await drive.files.list({ q: folderQuery, fields: 'files(id)', spaces: 'drive' });

        if (folderRes.data.files && folderRes.data.files.length > 0) {
// ... (código existente sin cambios) ...
            targetFolderId = folderRes.data.files[0].id;
        } else {
            const folderMetadata = {
// ... (código existente sin cambios) ...
                name: targetSubfolder,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentFolderId]
            };
            const createdFolder = await drive.files.create({
// ... (código existente sin cambios) ...
                resource: folderMetadata,
                fields: 'id'
            });
            targetFolderId = createdFolder.data.id;
        }
    }

    // 6. Preparar metadatos y media (sin cambios)
    const fileMetadata = {
// ... (código existente sin cambios) ...
      name: file.filename || `upload_${Date.now()}`,
      parents: [targetFolderId]
    };
    const media = {
// ... (código existente sin cambios) ...
      mimeType: file.mimeType,
      body: fs.createReadStream(tempFilePath),
    };

    // 7. Subir el archivo (sin cambios)
    const driveResponse = await drive.files.create({
// ... (código existente sin cambios) ...
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name',
    });
    
    const fileId = driveResponse.data.id;

    // 8. Hacer público (sin cambios)
    await drive.permissions.create({
// ... (código existente sin cambios) ...
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // 9. Obtener metadatos (sin cambios)
     const updatedFile = await drive.files.get({
// ... (código existente sin cambios) ...
       fileId: fileId,
       fields: 'webViewLink, webContentLink',
     });

    // 10. Devolver URL (sin cambios)
    return {
// ... (código existente sin cambios) ...
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
// ... (código existente sin cambios) ...
          message: 'Archivo subido con éxito.',
          fileId: fileId,
          fileName: driveResponse.data.name,
          imageUrl: updatedFile.data.webViewLink.replace('/view', '/preview')
      }),
    };

  } catch (error) {
    console.error('Error subiendo archivo a Drive (v3.0):', error);
    // El error 401 ahora se debería al Service Account, no al usuario.
// ... (código existente sin cambios) ...
    if (error.code === 401 || (error.response && error.response.status === 401)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Error de autenticación del Service Account.', details: error.message }) };
    }
    return {
// ... (código existente sin cambios) ...
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al subir el archivo.', details: error.message }),
    };
  } finally {
      // 11. Limpiar (sin cambios)
// ... (código existente sin cambios) ...
      if (tempFilePath) {
        try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Error limpiando archivo temporal:", e); }
      }
  }
};

