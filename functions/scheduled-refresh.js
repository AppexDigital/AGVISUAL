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
                fields: 'nextPageToken, files(id, thumbnailLink, webContentLink)',
                pageSize: 1000,
                pageToken: pageToken,
                supportsAllDrives: true, includeItemsFromAllDrives: true
            });
            
            if (res.data.files) {
                res.data.files.forEach(f => {
                    let link = null;
                    
                    // 1. Prioridad: Link de Contenido (Directo)
                    if (f.webContentLink) {
                        link = f.webContentLink;
                    } 
                    // 2. Respaldo: Link Original (s0)
                    else if (f.thumbnailLink) {
                        link = f.thumbnailLink.split('=')[0] + '=s0';
                    }
                    
                    if (link) {
                        // Siempre forzar HTTPS para evitar bloqueos en móvil
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

            await sheet.loadCells(); 
            const rows = await sheet.getRows();
            const headers = sheet.headerValues;
            const colIdIndex = headers.indexOf('fileId'); 
            const colUrlIndex = headers.indexOf(title === 'ClientLogos' ? 'logoUrl' : 'imageUrl');

            if (colIdIndex === -1 || colUrlIndex === -1) continue;

            let updates = 0;
            for (let i = 0; i < rows.length; i++) {
                const rowIndex = i + 1; 
                const cellId = sheet.getCell(rowIndex, colIdIndex);
                const cellUrl = sheet.getCell(rowIndex, colUrlIndex);
                const fileId = cellId.value;

                if (fileId && typeof fileId === 'string') {
                    const cleanId = fileId.trim();
                    if (freshLinksMap.has(cleanId)) {
                        const newLink = freshLinksMap.get(cleanId);
                        if (cellUrl.value !== newLink) {
                            cellUrl.value = newLink;
                            updates++;
                        }
                    }
                }
            }
            if (updates > 0) await sheet.saveUpdatedCells();
        }

        return { statusCode: 200, body: "Mantenimiento Exitoso" };

    } catch (error) {
        console.error("Error Cron:", error);
        return { statusCode: 500, body: error.message };
    }
};
