// functions/get-admin-data.js
// v10.0 - Read-time Hydration (Links Frescos)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis'); // Importamos la librería de Google completa
const { validateGoogleToken } = require('./google-auth-helper');

async function getServices() {
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  });
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  
  // Inicializamos también el cliente de Drive
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
      // Copia normalizada para búsquedas fáciles
      obj[header.toLowerCase().trim()] = val;
    });
    obj._rawId = row.rowIndex; 
    return obj;
  });
}

exports.handler = async (event, context) => {
  // 1. Seguridad
  if (!(await validateGoogleToken(event))) {
    return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
  }

  try {
    const { doc, drive } = await getServices();
    
    // 2. Determinar qué hojas cargar
    let requestedSheets = [];
    if (event.queryStringParameters && event.queryStringParameters.sheets) {
        requestedSheets = event.queryStringParameters.sheets.split(',');
    } else {
        // Carga por defecto (Dashboard)
        requestedSheets = ['Projects', 'ProjectImages', 'Bookings']; 
    }

    const adminData = {};

    // 3. Cargar datos de Sheets (Paralelo)
    const promises = requestedSheets.map(async (title) => {
        try {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) return { title, data: [] };
            await sheet.loadHeaderRow();
            const rows = await sheet.getRows();
            return { title, data: rowsToObjects(sheet, rows) };
        } catch (e) {
            console.warn(`Error cargando hoja ${title}: ${e.message}`);
            return { title, data: [] };
        }
    });

    const results = await Promise.all(promises);
    results.forEach(res => adminData[res.title] = res.data);

    // --- LÓGICA DE HIDRATACIÓN (READ-TIME HYDRATION) ---
    // Solo ejecutamos si se pidieron hojas que contienen imágenes
    if (requestedSheets.some(s => ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'].includes(s))) {
        
        try {
            // a. Pedimos a Drive una lista de TODOS los archivos de imagen (hasta 1000)
            // Esto es mucho más rápido que pedir uno por uno.
            const driveRes = await drive.files.list({
                q: "mimeType contains 'image/' and trashed = false",
                fields: 'files(id, thumbnailLink)',
                pageSize: 1000, 
                supportsAllDrives: true,
                includeItemsFromAllDrives: true
            });

            // b. Creamos un mapa rápido: ID -> Link Fresco
            const freshLinksMap = new Map();
            if (driveRes.data.files) {
                driveRes.data.files.forEach(f => {
                    if (f.thumbnailLink) {
                        // Generamos el link de alta calidad (1600px) al vuelo
                        // Este link funciona perfectamente en etiquetas <img> y no tiene problemas de CORS
                        const highResLink = f.thumbnailLink.replace(/=s\d+.*$/, '=s1600');
                        freshLinksMap.set(f.id, highResLink);
                    }
                });
            }

            // c. Inyectamos los links frescos en los datos antes de enviarlos al frontend
            const imageSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
            
            imageSheets.forEach(sheetKey => {
                if (adminData[sheetKey]) {
                    adminData[sheetKey] = adminData[sheetKey].map(row => {
                        // Si el registro tiene un fileId y encontramos un link fresco en Drive, lo usamos.
                        // Esto sobrescribe cualquier link viejo o roto que venga del Excel.
                        if (row.fileId && freshLinksMap.has(row.fileId)) {
                            row.imageUrl = freshLinksMap.get(row.fileId);
                        }
                        // Caso especial para la hoja de Logos (usa la columna 'logoUrl')
                        if (sheetKey === 'ClientLogos' && row.fileId && freshLinksMap.has(row.fileId)) {
                            row.logoUrl = freshLinksMap.get(row.fileId);
                        }
                        return row;
                    });
                }
            });

        } catch (driveError) {
            console.error("Advertencia: No se pudieron refrescar los links de Drive. Se usarán los datos cacheados.", driveError.message);
            // No fallamos la petición, simplemente entregamos los datos tal cual están en el sheet si Drive falla.
        }
    }
    // ---------------------------------------------------

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
