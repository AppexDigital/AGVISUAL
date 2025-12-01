// functions/get-admin-data.js
// v4.0 - CARGA SELECTIVA (SCALABLE ARCHITECTURE)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function executeWithRetry(operation, retries = 3, delay = 1000) {
    try {
        return await operation();
    } catch (error) {
        if (retries > 0 && (error.response?.status === 429 || error.code === 429 || error.code === 500)) {
            console.warn(`API Limit. Waiting ${delay}ms...`);
            await wait(delay);
            return executeWithRetry(operation, retries - 1, delay * 2);
        }
        throw error;
    }
}

async function getDoc() {
    const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await executeWithRetry(() => doc.loadInfo());
    return doc;
}

function rowsToObjects(sheet, rows) {
    if (!rows || rows.length === 0) return [];
    const headers = sheet.headerValues || [];
    return rows.map(row => {
        const obj = {};
        headers.forEach(header => {
            obj[header] = row.get(header) !== undefined && row.get(header) !== null ? row.get(header) : '';
        });
        return obj;
    });
}

exports.handler = async (event, context) => {
    if (!(await validateGoogleToken(event))) return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
    
    try {
        const doc = await getDoc();
        
        // ESTRATEGIA ESCALABLE: Leer parámetros de consulta
        // Si ?sheets=Projects,ProjectImages viene en la URL, solo cargamos eso.
        // Si no viene nada, cargamos solo la configuración básica (Dashboard).
        const requestedSheets = event.queryStringParameters?.sheets 
            ? event.queryStringParameters.sheets.split(',') 
            : ['Settings', 'Projects', 'ProjectImages', 'Bookings']; // Default Dashboard Data

        const adminData = {};
        
        // Procesamiento paralelo limitado (Batch de 4 para no saturar)
        const chunkSize = 4;
        for (let i = 0; i < requestedSheets.length; i += chunkSize) {
            const chunk = requestedSheets.slice(i, i + chunkSize);
            const promises = chunk.map(async (title) => {
                const sheet = doc.sheetsByTitle[title];
                if (!sheet) return { title, data: [] };
                return executeWithRetry(async () => {
                    await sheet.loadHeaderRow();
                    const rows = await sheet.getRows();
                    return { title, data: rowsToObjects(sheet, rows) };
                });
            });
            const results = await Promise.all(promises);
            results.forEach(r => adminData[r.title] = r.data);
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
