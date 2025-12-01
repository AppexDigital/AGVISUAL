// functions/upload-image.js
// v5.0 - ESTRUCTURA DE CARPETAS DINÁMICA
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

async function getOrCreateFolder(drive, parentId, folderName) {
    if (!folderName) return parentId;
    // Buscar carpeta existente
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    
    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    } else {
        // Crear si no existe
        const newFolder = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
            fields: 'id', supportsAllDrives: true
        });
        return newFolder.data.id;
    }
}

exports.handler = async (event, context) => {
  if (!event.headers.authorization?.startsWith('Bearer ')) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  const userAccessToken = event.headers.authorization.split(' ')[1];
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const rootFolderId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
  let tempFilePath = null;

  try {
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    
    // targetSubfolder = 'Projects' o 'Rentals'
    // parentFolderName = 'Boda Ana y Carlos' (Nombre del proyecto específico)
    const targetSubfolder = fields.targetSubfolder || 'General'; 
    const parentFolderName = fields.parentFolderName || null;

    if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No file.' }) };
    tempFilePath = file.filepath;

    const oAuth2Client = new google.auth.OAuth2();
    oAuth2Client.setCredentials({ access_token: userAccessToken });
    const drive = google.drive({ version: 'v3', auth: oAuth2Client });

    // 1. Entrar a la carpeta principal (ej: Projects)
    const categoryFolderId = await getOrCreateFolder(drive, rootFolderId, targetSubfolder);
    
    // 2. Entrar a la carpeta del proyecto específico (ej: Boda Ana)
    const finalFolderId = await getOrCreateFolder(drive, categoryFolderId, parentFolderName);

    // Subir Archivo
    const driveResponse = await drive.files.create({
      resource: { name: file.filename, parents: [finalFolderId] },
      media: { mimeType: file.mimeType, body: fs.createReadStream(tempFilePath) },
      fields: 'id, name, thumbnailLink, webViewLink',
      supportsAllDrives: true
    });
    
    const fileId = driveResponse.data.id;

    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true
    });

    let robustUrl = driveResponse.data.thumbnailLink;
    if (robustUrl) robustUrl = robustUrl.replace('=s220', '=s3000'); 
    else robustUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
          message: 'OK',
          fileId: fileId,
          imageUrl: robustUrl,
          driveFolderId: finalFolderId // Devolvemos el ID de la carpeta por si acaso
      }),
    };

  } catch (error) {
    console.error('Upload Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } finally {
      if (tempFilePath) fs.unlinkSync(tempFilePath);
  }
};
