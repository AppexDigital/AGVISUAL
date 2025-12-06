// functions/get-admin-data.js
// v10.0 - Read-time Hydration (Links Frescos)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { validateGoogleToken } = require('./google-auth-helper');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  const drive = google.drive({ version: 'v3', auth });
  return { doc, drive };
}

function rowsToObjects(sheet, rows) {
  if (!rows || rows.length === 0) return [];
  const headers = sheet.headerValues || [];
  return rows.map(row => {
    const obj = {};
    headers.forEach(header => {
      let val = row.get(header);
      if (val === undefined || val === null) val = '';
      obj[header] = val;
      obj[header.toLowerCase().trim()] = val;
    });
    return obj;
  });
}

exports.handler = async (event, context) => {
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const { doc, drive } = await getServices();
    
    let requestedSheets = [];
    if (event.queryStringParameters && event.queryStringParameters.sheets) {
        requestedSheets = event.queryStringParameters.sheets.split(',');
    } else {
        requestedSheets = ['Projects', 'ProjectImages', 'Bookings']; 
    }

    const adminData = {};

    // 1. Cargar datos de Sheets
    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (e) {
            console.warn(`Error hoja ${title}: ${e.message}`);
            return { title, data: [] };
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => adminData[res.title] = res.data);

    // --- HIDRATACIÓN DE LINKS (Versión Robusta) ---
    if (requestedSheets.some(s => ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'].includes(s))) {
        try {
            // Pedimos TODOS los archivos que no estén en la papelera.
            // Quitamos el filtro de 'image/' por si acaso Drive clasificó mal el tipo MIME,
            // ya que de todos modos filtraremos por ID.
            const driveRes = await drive.files.list({
                q: "trashed = false", 
                fields: 'files(id, thumbnailLink)',
                pageSize: 1000, 
                supportsAllDrives: true,
                includeItemsFromAllDrives: true
            });

            const freshLinksMap = new Map();
            if (driveRes.data.files) {
                driveRes.data.files.forEach(f => {
                    if (f.thumbnailLink) {
                        // Lógica de reemplazo segura: Cortar en '=' y añadir tamaño
                        const cleanLink = f.thumbnailLink.split('=')[0];
                        const highResLink = `${cleanLink}=s1600`;
                        freshLinksMap.set(f.id, highResLink);
                    }
                });
            }

            const imageSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            imageSheets.forEach(sheetKey => {
                if (adminData[sheetKey]) {
                    adminData[sheetKey] = adminData[sheetKey].map(row => {
                        // La clave es el FILE ID. Si existe en el mapa, tenemos link fresco.
                        if (row.fileId && freshLinksMap.has(row.fileId)) {
                            row.imageUrl = freshLinksMap.get(row.fileId);
                            // Marcamos visualmente para debug (opcional, puedes quitar esto luego)
                            // console.log('Link refrescado para:', row.fileId); 
                        }
                        if (sheetKey === 'ClientLogos' && row.fileId && freshLinksMap.has(row.fileId)) {
                            row.logoUrl = freshLinksMap.get(row.fileId);
                        }
                        return row;
                    });
                }
            });

        } catch (driveError) {
            console.error("Error crítico en hidratación:", driveError);
        }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminData),
    };

  } catch (error) {
    console.error('Data Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
