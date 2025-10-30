// functions/get-availability.js
    const { GoogleSpreadsheet } = require('google-spreadsheet');
    const { JWT } = require('google-auth-library');
    const dayjs = require('dayjs'); // Necesitaremos Day.js para manejar fechas fácilmente
    const utc = require('dayjs/plugin/utc');
    dayjs.extend(utc);

    // Nota: Necesitas instalar dayjs: npm install dayjs

    async function getDoc() {
      // (Misma función helper que en get-website-data.js)
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        scopes: ['[https://www.googleapis.com/auth/spreadsheets](https://www.googleapis.com/auth/spreadsheets)'],
      });
      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
      await doc.loadInfo();
      return doc;
    }

    // Helper para generar fechas individuales desde un rango
    function getDatesInRange(startDate, endDate) {
      const dates = [];
      let currentDate = dayjs.utc(startDate); // Usar UTC para evitar problemas de zona horaria
      const finalDate = dayjs.utc(endDate);
      while (!currentDate.isAfter(finalDate)) {
        dates.push(currentDate.format('YYYY-MM-DD'));
        currentDate = currentDate.add(1, 'day');
      }
      return dates;
    }

    exports.handler = async (event, context) => {
      if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
      }

      // Obtener el itemId de los query parameters
      const itemId = event.queryStringParameters.itemId;
      if (!itemId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing itemId parameter' }) };
      }

      try {
        const doc = await getDoc();
        const bookingsSheet = doc.sheetsByTitle['Bookings'];
        const blockedDatesSheet = doc.sheetsByTitle['BlockedDates']; // Nueva hoja

        const [bookingRows, blockedRows] = await Promise.all([
          bookingsSheet ? bookingsSheet.getRows() : Promise.resolve([]),
          blockedDatesSheet ? blockedDatesSheet.getRows() : Promise.resolve([]) 
        ]);

        const unavailableDates = new Set(); // Usamos un Set para evitar duplicados automáticamente

        // Procesar Reservas Confirmadas/Pagadas
        bookingRows.forEach(row => {
          const rowData = row.toObject();
          const status = rowData.status ? rowData.status.toLowerCase() : '';
          if (rowData.itemId === itemId && (status === 'confirmado' || status === 'pagado') && rowData.startDate && rowData.endDate) {
            getDatesInRange(rowData.startDate, rowData.endDate).forEach(date => unavailableDates.add(date));
          }
        });

        // Procesar Bloqueos Administrativos
        blockedRows.forEach(row => {
          const rowData = row.toObject();
          if (rowData.itemId === itemId && rowData.startDate && rowData.endDate) {
            getDatesInRange(rowData.startDate, rowData.endDate).forEach(date => unavailableDates.add(date));
          }
        });

        // Convertir el Set a un Array ordenado
        const sortedUnavailableDates = Array.from(unavailableDates).sort();

        return {
          statusCode: 200,
           headers: {
             'Content-Type': 'application/json',
             'Access-Control-Allow-Origin': '*', 
          },
          body: JSON.stringify(sortedUnavailableDates),
        };

      } catch (error) {
        console.error(`Error fetching availability for itemId ${itemId}:`, error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Failed to fetch availability', details: error.message }),
        };
      }
    };
    
