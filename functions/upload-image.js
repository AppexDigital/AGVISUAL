// functions/upload-image.js
// v6.0 - ORGANIZACIÓN POR NOMBRE & SUBIDA SEGURA
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    try {
      const busboy = Busboy({ headers: { 'content-type': event.headers['content-type'] || event.headers['Content-Type'] } });
      const fields = {}; const files = {}; const tmpdir = os.tmpdir();
      busboy.on('field', (n, v) => fields[n] = v);
      busboy.on('file', (n, file, info) => {
        const filepath = path.join(tmpdir, `up_${Date.now()}_${info.filename}`);
        file.pipe(fs.createWriteStream(filepath)).on('finish', () => files[n] = { ...info, filepath });
      });
      busboy.on('close', () => resolve({ fields, files }));
      busboy.on('error', reject);
      busboy.end(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary'));
    } catch (e) { reject(e); }
  });
}

async function getOrCreateFolder(drive, parentId, folderName) {
    // Buscar por NOMBRE exacto dentro del padre
    const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${parentId}' in parents and trashed = false`;
    const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    
    if (res.data.files.length > 0) return res.data.files[0].id;
    
    // Si no existe, crearla
    const newFolder = await drive.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id', supportsAllDrives: true
    });
    return newFolder.data.id;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const userToken = event.headers.authorization?.split(' ')[1];
  if (!userToken) return { statusCode: 401, body: 'Unauthorized' };

  let tempFilePath = null;
  try {
    const { fields, files } = await parseMultipartForm(event);
    const file = files.file;
    // AQUÍ LA CLAVE: Usamos el nombre legible (parentFolderName)
    const folderName = fields.parentFolderName || 'General'; 
    const subFolderType = fields.targetSubfolder || 'Varios';

    if (!file) throw new Error('No file uploaded');
    tempFilePath = file.filepath;

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: userToken });
    const drive = google.drive({ version: 'v3', auth });

    const rootId = process.env.GOOGLE_DRIVE_ASSET_FOLDER_ID;
    // 1. Carpeta Tipo (Proyectos / Alquiler)
    const typeFolderId = await getOrCreateFolder(drive, rootId, subFolderType);
    // 2. Carpeta Específica (Nombre del Proyecto)
    const targetFolderId = await getOrCreateFolder(drive, typeFolderId, folderName);

    const res = await drive.files.create({
      resource: { name: file.filename, parents: [targetFolderId] },
      media: { mimeType: file.mimeType, body: fs.createReadStream(tempFilePath) },
      fields: 'id, thumbnailLink, webViewLink',
      supportsAllDrives: true
    });

    await drive.permissions.create({ fileId: res.data.id, requestBody: { role: 'reader', type: 'anyone' } });

    let imgUrl = res.data.thumbnailLink ? res.data.thumbnailLink.replace('=s220', '=s3000') : res.data.webViewLink;

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'OK', fileId: res.data.id, imageUrl: imgUrl, driveFolderId: targetFolderId })
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
};
