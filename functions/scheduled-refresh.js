const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

exports.handler = async (event, context) => {
    console.log("Iniciando Mantenimiento de Links...");

    try {
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
        });
        const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
        const drive = google.drive({ version: 'v3', auth });

        await doc.loadInfo();

        // 1. Obtener catálogo fresco de Drive
        const freshLinksMap = new Map();
        let pageToken = null;
        
        do {
            const res = await drive.files.list({
                q: "trashed = false",
                fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)', // Pedimos todo por si acaso
                pageSize: 1000,
                pageToken: pageToken,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            
            if (res.data.files) {
                res.data.files.forEach(f => {
                    let link = null;
                    // Estrategia Robusta: Prioridad webContentLink, luego s0
                    if (f.webContentLink) {
                        link = f.webContentLink;
                    } else if (f.thumbnailLink) {
                        link = f.thumbnailLink.split('=')[0] + '=s0';
                    }

                    if (link) {
                        // Forzamos HTTPS
                        link = link.replace(/^http:\/\//i, 'https://');
                        freshLinksMap.set(f.id, link);
                    }
                });
            }
            pageToken = res.data.nextPageToken;
        } while (pageToken);

        // 2. Actualizar Excel
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];

        for (const title of targetSheets) {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            // --- CORRECCIÓN CRÍTICA AQUÍ ---
            await sheet.loadHeaderRow(); // <--- ESTA LÍNEA FALTABA Y CAUSABA EL ERROR
            await sheet.loadCells();     // Cargamos celdas para editar
            // -------------------------------

            const rows = await sheet.getRows();
            const headers = sheet.headerValues;
            const colIdIndex = headers.indexOf('fileId'); 
            const colUrlIndex = headers.indexOf(title === 'ClientLogos' ? 'logoUrl' : 'imageUrl');

            if (colIdIndex === -1 || colUrlIndex === -1) continue;

            let updates = 0;
            // Iteramos sobre las filas usando el índice visual del Excel
            for (let i = 0; i < rows.length; i++) {
                const rowIndex = i + 1; // +1 por el header
                const cellId = sheet.getCell(rowIndex, colIdIndex);
                const cellUrl = sheet.getCell(rowIndex, colUrlIndex);
                const fileId = cellId.value;

                if (fileId && typeof fileId === 'string') {
                    const cleanId = fileId.trim();
                    if (freshLinksMap.has(cleanId)) {
                        const newLink = freshLinksMap.get(cleanId);
                        // Solo gastamos recursos si el link es diferente
                        if (cellUrl.value !== newLink) {
                            cellUrl.value = newLink;
                            updates++;
                        }
                    }
                }
            }
            
            if (updates > 0) {
                await sheet.saveUpdatedCells();
                console.log(`Hoja ${title}: ${updates} links actualizados.`);
            }
        }

        return { statusCode: 200, body: "Mantenimiento Exitoso: Links Actualizados" };

    } catch (error) {
        console.error("Error Cron:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
