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
        
        try {
            do {
                const res = await drive.files.list({
                    q: "trashed = false",
                    fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)', 
                    pageSize: 1000,
                    pageToken: pageToken,
                    supportsAllDrives: true, includeItemsFromAllDrives: true
                });
                
                if (res.data.files) {
                    res.data.files.forEach(f => {
                        let link = null;
                        if (f.webContentLink) link = f.webContentLink;
                        else if (f.thumbnailLink) link = f.thumbnailLink.split('=')[0] + '=s0';

                        if (link) {
                            link = link.replace(/^http:\/\//i, 'https://');
                            freshLinksMap.set(f.id, link);
                        }
                    });
                }
                pageToken = res.data.nextPageToken;
            } while (pageToken);
        } catch (driveError) {
            return { statusCode: 500, body: `Error conectando con Drive: ${driveError.message}` };
        }

        // 2. Actualizar Excel (Lógica de Rejilla Segura)
        const targetSheets = ['ProjectImages', 'RentalItemImages', 'ServiceImages', 'ClientLogos'];
        let logReport = "";

        for (const title of targetSheets) {
            const sheet = doc.sheetsByTitle[title];
            if (!sheet) continue;

            try {
                await sheet.loadHeaderRow(); 
                await sheet.loadCells(); // Carga toda la hoja en memoria
                
                const headers = sheet.headerValues;
                const colIdIndex = headers.indexOf('fileId'); 
                const colUrlIndex = headers.indexOf(title === 'ClientLogos' ? 'logoUrl' : 'imageUrl');

                if (colIdIndex === -1 || colUrlIndex === -1) {
                    logReport += `[${title}] Saltado: Falta columna fileId o URL.\n`;
                    continue;
                }

                let updates = 0;
                // Recorremos por índice de fila real (rowCount)
                // Empezamos en 1 para saltar el encabezado (fila 0)
                for (let r = 1; r < sheet.rowCount; r++) {
                    const cellId = sheet.getCell(r, colIdIndex);
                    const fileId = cellId.value;

                    if (fileId && typeof fileId === 'string') {
                        const cleanId = fileId.trim();
                        if (freshLinksMap.has(cleanId)) {
                            const newLink = freshLinksMap.get(cleanId);
                            const cellUrl = sheet.getCell(r, colUrlIndex);
                            
                            if (cellUrl.value !== newLink) {
                                cellUrl.value = newLink;
                                updates++;
                            }
                        }
                    }
                }
                
                if (updates > 0) {
                    await sheet.saveUpdatedCells();
                    logReport += `[${title}] Éxito: ${updates} links actualizados.\n`;
                } else {
                    logReport += `[${title}] Al día: No hubo cambios necesarios.\n`;
                }

            } catch (sheetError) {
                console.error(`Error en hoja ${title}:`, sheetError);
                logReport += `[${title}] ERROR CRÍTICO: ${sheetError.message}\n`;
            }
        }

        return { statusCode: 200, body: `Mantenimiento Completado.\n\nReporte:\n${logReport}` };

    } catch (error) {
        console.error("Error General:", error);
        return { statusCode: 500, body: `Error General del Sistema: ${error.message}` };
    }
};
