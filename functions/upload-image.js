// functions/upload-image.js
// v3.0 - ARQUITECTURA DE SERVICE ACCOUNT (ROBOT)
// Esta versión valida el token del usuario, pero usa el Service Account
// para realizar la subida, evitando el error de "storage quota" y el de "scopes".

const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');
// Importamos el validador de token del usuario
const { validateGoogleToken } = require('./google-auth-helper');

// Helper para parsear el form data (sin cambios)
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

      const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');
      busboy.end(bodyBuffer);

    } catch (error) {
      reject(error);
    }
  });
}

// --- Handler Principal (v3.0) ---
exports.handler = async (event, context) => {
  // 1. **SEGURIDAD:** Validar el token de acceso del USUARIO.
  // Esto asegura que solo un usuario logueado puede intentar subir archivos.
  if (!(await validateGoogleToken(event))) {
    return {
      statusCode: 401, // No autorizado
      body: JSON.stringify({ error: 'No autorizado. Token de Google inválido o expirado.' }),
    };
  }
  // Si llegamos aquí, el usuario está logueado y es válido.

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
    // 3. Parsear el Form Data (sin cambios)
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    const targetSubfolder = fields.targetSubfolder || 'general';

    if (!file) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No se recibió ningún archivo (key="file").' }) };
    }
    
    tempFilePath = file.filepath;

    // 4. *** INICIO DEL AJUSTE DE CIRUJANO v9.0 ***
    // Crear Cliente JWT (ROBOT / SERVICE ACCOUNT) para la subida
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/drive' 
        // Nota: El robot necesita el scope 'drive' completo para crear,
        // modificar permisos y gestionar carpetas.
      ],
    });
    
    // Crear el servicio de Drive usando la autenticación del ROBOT
    const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });
    // *** FIN DEL AJUSTE DE CIRUJANO v9.0 ***

    // 5. Buscar o crear la subcarpeta (sin cambios)
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

    // 6. Preparar metadatos y media (sin cambios)
    const fileMetadata = {
      name: file.filename || `upload_${Date.now()}`,
      parents: [targetFolderId]
    };
    const media = {
      mimeType: file.mimeType,
      body: fs.createReadStream(tempFilePath),
    };

    // 7. Subir el archivo (sin cambios)
    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name',
    });
    
    const fileId = driveResponse.data.id;

    // 8. Hacer público (sin cambios)
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // 9. Obtener metadatos (sin cambios)
     const updatedFile = await drive.files.get({
       fileId: fileId,
       fields: 'webViewLink, webContentLink',
     });

    // 10. Devolver URL (sin cambios)
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
    console.error('Error subiendo archivo a Drive (v3.0 - Robot):', error);
    
    // ESTE ES EL ERROR QUE YA SOLUCIONASTE AL COMPARTIR LA CARPETA
    if (error.message && error.message.includes('storage quota')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Error de Cuota de Almacenamiento. Revisa los permisos del Service Account en la carpeta de Drive.', details: error.message })};
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Error interno al subir el archivo.', details: error.message }),
    };
  } finally {
      // 11. Limpiar (sin cambios)
      if (tempFilePath) {
        try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Error limpiando archivo temporal:", e); }
      }
  }
};

