// functions/get-admin-data.js
// v3.0 - CON CONTROL DE FLUJO Y RETRY (Anti-429)
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { validateGoogleToken } = require('./google-auth-helper');

// --- UTILS: Retry Logic ---
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function executeWithRetry(operation, retries = 3, delay = 1000) {
    try {
        return await operation();
    } catch (error) {
        // Si es error de cuota (429) o error de servidor (5xx)
        if (retries > 0 && (error.response?.status === 429 || error.code === 429 || error.code === 500)) {
            console.warn(`API Rate Limit hit. Waiting ${delay}ms... Retries left: ${retries}`);
            await wait(delay);
            return executeWithRetry(operation, retries - 1, delay * 2); // Backoff exponencial
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
    if (!(await validateGoogleToken(event))) {
        return { statusCode: 401, body: JSON.stringify({ error: 'No autorizado.' }) };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const doc = await getDoc();
        const sheetTitles = [
            'Settings', 'About', 'Videos', 'ClientLogos', 'Projects', 'ProjectImages',
            'Services', 'ServiceContentBlocks', 'ServiceImages',
            'RentalCategories', 'RentalItems', 'RentalItemImages',
            'Bookings', 'BlockedDates'
        ];

        const adminData = {};

        // LECTURA SECUENCIAL OPTIMIZADA (Para evitar golpear el límite de 60 req/min)
        // Leemos en bloques de 3 en 3 para balancear velocidad y seguridad
        const chunkSize = 3;
        for (let i = 0; i < sheetTitles.length; i += chunkSize) {
            const chunk = sheetTitles.slice(i, i + chunkSize);
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
        console.error('Error Admin Data:', error);
        return {
            statusCode: 500, // Si falla después de los reintentos
            body: JSON.stringify({ error: 'Error obteniendo datos (API Busy). Intenta en unos segundos.', details: error.message }),
        };
    }
};
