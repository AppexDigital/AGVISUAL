// functions/upload-image.js
// v3.1 - FIX IMAGENES VISIBLES Y SHARED DRIVES
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({
        headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] }
      });
      const fields = {};
      const files = {};
      const tmpdir = os.tmpdir();

      busboy.on('field', (fieldname, val) => fields[fieldname] = val);
      busboy.on('file', (fieldname, file, { filename, mimeType }) => {
        const filepath = path.join(tmpdir, `upload-${Date.now()}-${filename}`);
        const writeStream = fs.createWriteStream(filepath);
        file.pipe(writeStream);
        file.on('end', () => files[fieldname] = { filepath, filename, mimeType });
      });
      busboy.on('close', () => resolve({ fields, files }));
      busboy.on('error', err => reject(err));
      busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary'));
    } catch (error) { reject(error); }
  });
}

exports.handler = async (event, context) => {
  if (!event.headers.authorization?.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  const userAccessToken = event.headers.authorization.split(' ')[1];
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const parentFolderId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
  let tempFilePath = null;

  try {
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    const targetSubfolder = fields.targetSubfolder || 'general';

    if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No file.' }) };
    tempFilePath = file.filepath;

    const oAuth2Client = new google.auth.OAuth2();
    oAuth2Client.setCredentials({ access_token: userAccessToken });
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    // Buscar/Crear Subcarpeta
    let targetFolderId = parentFolderId;
    if (targetSubfolder !== 'general') {
        const q = `mimeType='application/vnd.google-apps.folder' and name='${targetSubfolder}' and '${parentFolderId}' in parents and trashed = false`;
        const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        if (res.data.files.length > 0) {
            targetFolderId = res.data.files[0].id;
        } else {
            const newFolder = await drive.files.create({
                resource: { name: targetSubfolder, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
                fields: 'id', supportsAllDrives: true
            });
            targetFolderId = newFolder.data.id;
        }
    }

    // Subir Archivo
    const driveResponse = await drive.files.create({
      resource: { name: file.filename, parents: [targetFolderId] },
      media: { mimeType: file.mimeType, body: fs.createReadStream(tempFilePath) },
      fields: 'id, name, webViewLink, thumbnailLink', // Pedimos thumbnailLink también
      supportsAllDrives: true
    });
    
    const fileId = driveResponse.data.id;

    // Hacer Público
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    // Construir URL Directa para <img>
    // Usamos el formato uc?export=view que es el estándar para hotlinking
    const directUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
          message: 'OK',
          fileId: fileId,
          // Devolvemos la URL directa para que se vea en el HTML
          imageUrl: directUrl 
      }),
    };

  } catch (error) {
    console.error('Upload Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } finally {
      if (tempFilePath) fs.unlinkSync(tempFilePath);
  }
};
