// functions/get-website-data.js
    const { GoogleSpreadsheet } = require('google-spreadsheet');
    const { JWT } = require('google-auth-library');

    // Helper para inicializar la conexión con Google Sheets usando Service Account
    async function getDoc() {
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Asegura formato correcto de la clave
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
      await doc.loadInfo(); // Carga metadatos del documento
      return doc;
    }
    
    // *** AJUSTE DE CIRUJANO v7.0: (Helper 'rowsToObjects' copiado de get-admin-data) ***
    // Convertir filas a objetos (con encabezados completos)
    function rowsToObjects(sheet, rows) {
      if (!rows || rows.length === 0) return [];
      const headers = sheet.headerValues || []; // Leer desde el objeto 'sheet'
      return rows.map(row => {
        const obj = {};
        headers.forEach(header => {
          obj[header] = row.get(header) !== undefined && row.get(header) !== null ? row.get(header) : '';
        });
        return obj;
      });
    }
    // *** FIN DEL AJUSTE v7.0 ***

    // Función principal de Netlify
    exports.handler = async (event, context) => {
      // Solo permitir peticiones GET
      if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
      }

      try {
        const doc = await getDoc();

        // Nombres exactos de las hojas que necesitamos leer para el sitio público
        const sheetTitles = [
          'Settings', 
          'About', 
          'Videos',       // Videos generales
          'ClientLogos', 
          'Projects', 
          'ProjectImages', // Imágenes de proyectos (se filtrarán)
          'Services', 
          'ServiceContentBlocks', 
          'ServiceImages', 
          'RentalCategories', 
          'RentalItems', 
          'RentalItemImages'
          // No leemos Bookings ni BlockedDates aquí, eso es para get-availability
        ];

        // Leer todas las hojas en paralelo para mayor eficiencia
        const sheetPromises = sheetTitles.map(async (title) => {
          const sheet = doc.sheetsByTitle[title];
          if (!sheet) {
            console.warn(`Sheet "${title}" not found.`);
            return { title, data: [] }; // Devuelve array vacío si la hoja no existe
          }
          await sheet.loadHeaderRow(); // Asegurarse de que los encabezados están cargados
          const rows = await sheet.getRows();
          
          // *** AJUSTE DE CIRUJANO v7.0: Usar el helper robusto ***
          return { title, data: rowsToObjects(sheet, rows) };
        });

        // Esperar a que todas las promesas de lectura se completen
        const results = await Promise.all(sheetPromises);

        // Mapear resultados a un objeto más manejable
        const sheetsData = {};
        sheetTitles.forEach((title, index) => {
          // *** AJUSTE DE CIRUJANO v7.0: Usar el objeto de resultado
          sheetsData[results[index].title] = results[index].data;
        });

        // --- Procesamiento Específico ---

        // 1. Filtrar ProjectImages para el Portafolio Principal
        const portfolioImages = sheetsData.ProjectImages
          .filter(img => img.showInPortfolio && img.showInPortfolio.toLowerCase() === 'si')
          // *** INICIO DEL AJUSTE DE CIRUJANO v7.2 ***
          // Ordenar por el nuevo campo 'portfolioOrder'
          .sort((a, b) => (parseInt(a.portfolioOrder) || 99) - (parseInt(b.portfolioOrder) || 99));
          // *** FIN DEL AJUSTE DE CIRUJANO v7.2 ***

        // 2. Simplificar Settings a un objeto clave-valor
        const settings = sheetsData.Settings.reduce((acc, setting) => {
          if (setting.key) {
            acc[setting.key] = setting.value;
          }
          return acc;
        }, {});
        
        // 3. Simplificar About a un objeto clave-valor
        const aboutContent = sheetsData.About.reduce((acc, item) => {
           if (item.section) {
            acc[item.section] = item.content;
          }
          return acc;
        }, {});

        // 4. Agrupar imágenes y contenido por Servicio
        const servicesWithContent = sheetsData.Services.map(service => ({
            ...service,
            contentBlocks: sheetsData.ServiceContentBlocks
                .filter(block => block.serviceId === service.id)
                .sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0)),
            images: sheetsData.ServiceImages
                .filter(img => img.serviceId === service.id)
                .sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0)),
        })).sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0));

        // 5. Agrupar imágenes por Item de Alquiler
        const rentalItemsWithImages = sheetsData.RentalItems.map(item => ({
            ...item,
            images: sheetsData.RentalItemImages
                .filter(img => img.itemId === item.id)
                .sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0)),
        })).sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0));
        
        // 6. Agrupar imágenes por Proyecto y encontrar portada
         const projectsWithImages = sheetsData.Projects.map(project => {
            const projectImages = sheetsData.ProjectImages
                .filter(img => img.projectId === project.id)
                .sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0)); // Orden interno
            // Encuentra la portada (puede que ya esté en project.coverImageUrl o la leemos de projectImages)
            const coverImage = projectImages.find(img => img.isCover && img.isCover.toLowerCase() === 'si');
            return {
                ...project,
                // Si la hoja Projects no tiene coverImageUrl, la tomamos de ProjectImages
                coverImageUrl: project.coverImageUrl || coverImage?.imageUrl || projectImages[0]?.imageUrl || '', 
                images: projectImages // Devolvemos todas las imágenes del proyecto para la vista de detalle
            };
        }).sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0));


        // Estructura final de datos a devolver al frontend público
        const websiteData = {
          settings: settings,
          about: aboutContent,
          portfolioGallery: portfolioImages, // Imágenes filtradas para la galería principal
          videos: sheetsData.Videos.sort((a, b) => (parseInt(a.order) || 0) - (parseInt(b.order) || 0)),
          clientLogos: sheetsData.ClientLogos.sort((a, b) => (parseInt(a.order) || 0) - (parseInt(b.order) || 0)),
          projects: projectsWithImages, // Proyectos con TODAS sus imágenes para los detalles
          services: servicesWithContent,
          rentalCategories: sheetsData.RentalCategories.sort((a, b) => (parseInt(a.order) || 99) - (parseInt(b.order) || 0)),
          rentalItems: rentalItemsWithImages, // Items con sus imágenes agrupadas
        };

        return {
          statusCode: 200,
          headers: {
             'Content-Type': 'application/json',
             'Access-Control-Allow-Origin': '*', // Permitir acceso desde cualquier origen (ajustar si es necesario)
          },
          body: JSON.stringify(websiteData),
        };

      } catch (error) {
        console.error('Error fetching website data:', error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'Failed to fetch website data', details: error.message }),
        };
      }
    };
