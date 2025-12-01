// functions/upload-image.js
// v3.0 - OPTIMIZADO PARA GOOGLE WORKSPACE (SHARED DRIVES)
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

// Helper para parsear el form data
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

      busboy.on('file', (fieldname, file, { filename, mimeType }) => {
        const filepath = path.join(tmpdir, `busboy-upload-${Date.now()}-${filename}`);
        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);

        file.on('end', () => {
          files[fieldname] = { filepath, filename, mimeType };
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

exports.handler = async (event, context) => {
  // 1. Verificar Autorización (Token de usuario de Google)
  if (!event.headers.authorization || !event.headers.authorization.startsWith('Bearer ')) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado. Falta token.' }) };
  }
  const userAccessToken = event.headers.authorization.split(' ')[1];

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const parentFolderId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
  if (!parentFolderId) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Error de configuración del servidor (Folder ID).' }) };
  }

  let tempFilePath = null;

  try {
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    const targetSubfolder = fields.targetSubfolder || 'general';

    if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No se recibió archivo.' }) };
    
    tempFilePath = file.filepath;

    // 2. Autenticación OAuth2 con el token del USUARIO
    const oAuth2Client = new google.auth.OAuth2();
    oAuth2Client.setCredentials({ access_token: userAccessToken });
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    // 3. Buscar o crear subcarpeta (CON SOPORTE PARA SHARED DRIVES)
    let targetFolderId = parentFolderId;
    
    if (targetSubfolder !== 'general') {
        // La clave: supportsAllDrives y includeItemsFromAllDrives
        const folderQuery = `mimeType='application/vnd.google-apps.folder' and name='${targetSubfolder}' and '${parentFolderId}' in parents and trashed = false`;
        
        const folderRes = await drive.files.list({ 
            q: folderQuery, 
            fields: 'files(id)', 
            supportsAllDrives: true,        // <--- VITAL
            includeItemsFromAllDrives: true // <--- VITAL
        });

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
                fields: 'id',
                supportsAllDrives: true // <--- VITAL
            });
            targetFolderId = createdFolder.data.id;
        }
    }

    // 4. Subir Archivo
    const fileMetadata = {
      name: file.filename,
      parents: [targetFolderId]
    };
    const media = {
      mimeType: file.mimeType,
      body: fs.createReadStream(tempFilePath),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, name',
      supportsAllDrives: true // <--- VITAL
    });
    
    const fileId = driveResponse.data.id;

    // 5. Hacer público (Permisos)
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true // <--- VITAL
    });

    // 6. Obtener Link final
     const updatedFile = await drive.files.get({
       fileId: fileId,
       fields: 'webViewLink',
       supportsAllDrives: true // <--- VITAL
     });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
          message: 'Subido con éxito.',
          imageUrl: updatedFile.data.webViewLink.replace('/view', '/preview') // Link para embed
      }),
    };

  } catch (error) {
    console.error('Error Drive:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Error al subir.', details: error.message }) };
  } finally {
      if (tempFilePath) try { fs.unlinkSync(tempFilePath); } catch (e) {}
  }
};

