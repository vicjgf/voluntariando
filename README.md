# 🤝 Voluntariando

**Plataforma de gestión de voluntariado comunitario, lista para usar y replicar.**

Permite que organizaciones publiquen eventos de voluntariado y que cualquier persona se inscriba **sin necesidad de crear cuenta**. Los coordinadores gestionan eventos e inscritos con un login seguro.

Construida con **Cloudflare Workers + Firebase**. Costo de operación: **$0** en planes gratuitos para uso comunitario.

> 💚 Esta es una plantilla abierta. Si la replicas, usarás **tu propia** cuenta de Google, GitHub, Firebase y Cloudflare. Todo lo que necesitas está en esta guía.

---

## ✨ Características

- **Inscripción sin registro** — los voluntarios solo llenan un formulario
- **Campos configurables por evento** — el coordinador elige qué datos pedir
- **Privacidad por diseño** — el público solo ve nombres de pila y conteos; los datos sensibles (correos, teléfonos) solo los ven los coordinadores
- **Roles** — un administrador y varios coordinadores
- **Estados flexibles** — eventos y actividades se activan, desactivan, marcan llenos u ocultan
- **Login sin contraseña** — Google o link mágico por correo
- **Seguridad robusta** — la base de datos está cerrada; solo el servidor (Worker) accede a ella

---

## 🏛 Cómo funciona (arquitectura)

```
┌──────────────┐      ┌──────────────────┐      ┌──────────────┐
│   Navegador  │─────▶│ Cloudflare Worker│─────▶│  Firestore   │
│  (la página) │◀─────│  (servidor/API)  │◀─────│ (base datos) │
└──────────────┘      └──────────────────┘      └──────────────┘
```

El navegador **nunca** toca la base de datos directamente. Todo pasa por el Worker, que decide qué información entregar según quién pregunta. Así los datos personales quedan protegidos.

---

## ⚠️ Esta plantilla viene en MODO DEMO

Para que cualquiera pueda experimentar, esta plantilla viene configurada como **demo abierta**:

- **Sin iniciar sesión** → eres visitante (ves eventos y te inscribes)
- **Al iniciar sesión** (con cualquier Google o correo) → te conviertes en **coordinador** automáticamente y puedes crear, editar y borrar eventos

Esto es ideal para que la gente pruebe la plataforma sin pedirte permiso. Pero **no es seguro para una instalación real**, porque cualquiera podría modificar los eventos.

### Cómo pasar al modo seguro (al hacer tu instalación real)

En el archivo `src/worker.js`, busca el bloque marcado:
```
⚠️ MODO DEMO ACTIVADO
```
y **borra la línea**:
```javascript
return 'coordinador'; // ← BORRA ESTA LÍNEA PARA EL MODO SEGURO
```

Con eso, solo los correos que el **administrador** agregue a la lista de coordinadores (desde el panel 👥 Coordinadores) tendrán permisos de edición. El resto serán visitantes.

También puedes borrar el banner "🧪 Modo demostración" de la pantalla de login en `public/index.html` (está marcado con comentarios).

---

## 🚀 Cómo replicar este proyecto (paso a paso)

Para tener tu propia copia funcionando necesitas 4 cuentas **gratuitas**: Google, GitHub, Firebase (usa tu cuenta Google) y Cloudflare.

### Paso 1 — Crea tu proyecto Firebase

1. Entra a [console.firebase.google.com](https://console.firebase.google.com) → **Agregar proyecto**
2. Ponle un nombre (ej. `mi-voluntariado`). Puedes desactivar Google Analytics.
3. Crea una base de datos **Firestore Database** (modo producción)
4. En **Authentication → Sign-in method**, habilita:
   - **Google**
   - **Correo electrónico/Contraseña** → y dentro, activa también **Vínculo de correo (sin contraseña)**

### Paso 2 — Genera la llave de servicio

1. ⚙️ (engrane) → **Configuración del proyecto** → pestaña **Cuentas de servicio**
2. Botón **Generar nueva clave privada** → se descarga un archivo `.json`
3. Guárdalo bien. **Nunca lo subas a GitHub** (contiene la llave maestra de tu base de datos).

### Paso 3 — Pon tu configuración web en el código

1. En Firebase: ⚙️ → **Configuración del proyecto** → **General** → baja a **Tus apps** → crea una app web (`</>`)
2. Copia el bloque `firebaseConfig` que aparece
3. En el archivo `public/index.html`, busca el bloque marcado con:
   ```
   ⚠️ SI REPLICAS ESTE PROYECTO: reemplaza TODO este bloque
   ```
   y pega ahí **tu** configuración.

### Paso 4 — Sube el código a TU GitHub

1. Haz **fork** de este repositorio (o crea uno nuevo y sube estos archivos)
2. Asegúrate de que se suban las carpetas `src/` y `public/` con sus archivos

### Paso 5 — Despliega en Cloudflare

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create**
2. Conecta tu repositorio de GitHub
3. **Build command**: déjalo vacío · **Deploy command**: `npx wrangler deploy`

### Paso 6 — Configura las 4 variables de entorno ⚠️ (el paso donde todos se atoran)

Las variables van en **Settings → Variables and Secrets** del Worker (la sección de **runtime**, NO la de Build). Agrega estas 4, sacadas de tu archivo `.json`:

| Nombre | Valor | Tipo |
|---|---|---|
| `FIREBASE_PROJECT_ID` | campo `project_id` del JSON | Variable |
| `FIREBASE_CLIENT_EMAIL` | campo `client_email` del JSON | Variable |
| `FIREBASE_PRIVATE_KEY` | campo `private_key` del JSON (completo, **sin** las comillas exteriores) | **Secret** |
| `ADMIN_EMAIL` | tu correo (serás el administrador) | Variable |

> 💡 **Truco:** después de agregar las variables, abre `https://TU-WORKER.workers.dev/api/diag` en el navegador. Te dirá si las 4 llegaron bien (`presente`) o faltan (`FALTA`). Cuando todo diga "presente", **borra el endpoint `/api/diag`** del archivo `src/worker.js` por seguridad.

### Paso 7 — Cierra la base de datos

En Firebase → **Firestore → Reglas**, pega esto y publica:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```
Todo cerrado: solo tu Worker (con la llave de servicio) puede entrar.

### Paso 8 — Autoriza tu dominio

En Firebase → **Authentication → Settings → Dominios autorizados**, agrega la URL que te dio Cloudflare (ej. `mi-voluntariado.workers.dev`).

¡Listo! 🎉

---

## 🖼 Cómo poner tu logo

La plantilla viene con un placeholder que dice **"Tu logo aquí"**. Para poner el tuyo:

### Opción A — Logo alojado en internet (lo más fácil)
1. Sube tu logo a un servicio como [imgur.com](https://imgur.com) o [postimages.org](https://postimages.org) y copia el enlace directo de la imagen (termina en `.png` o `.jpg`)
2. En `public/index.html` hay **dos lugares** con logo:

   **a) El encabezado** — busca el comentario:
   ```html
   <!-- LOGO del encabezado: reemplaza por <img src="URL_DE_TU_LOGO" style="height:32px;"/> -->
   <span style="font-size:26px;">🤝</span>
   ```
   Reemplaza la línea del `<span>` por:
   ```html
   <img src="https://URL-DE-TU-LOGO.png" style="height:32px;"/>
   ```

   **b) La pantalla de inicio de sesión** — busca el bloque:
   ```html
   <div style="...">Tu logo<br>aquí</div>
   ```
   Reemplázalo por:
   ```html
   <img src="https://URL-DE-TU-LOGO.png" style="width:140px;margin-bottom:16px;"/>
   ```

### Opción B — Logo como archivo en el proyecto
1. Pon tu archivo (ej. `logo.png`) dentro de la carpeta `public/`
2. Usa la ruta local en los `<img>`:
   ```html
   <img src="/logo.png" style="height:32px;"/>
   ```

### Recomendaciones para el logo
- Formato **PNG con fondo transparente** se ve mejor sobre el fondo de color
- Para el encabezado, una imagen ancha (horizontal) funciona bien
- Para la pantalla de login, un logo cuadrado o circular luce mejor
- Si tu logo es oscuro, recuerda que el fondo es de color: prueba una versión clara

---

## 🎨 Cómo cambiar los colores

En `public/index.html`, al inicio del `<style>`, está la paleta:
```css
--verde:#2ec4b6; --verde-vivo:#06d6a0; --azul:#3a86ff;
--amarillo:#ffd23f; --naranja:#ff9f1c; --rojo:#e63946;
```
Cambia los códigos de color (en formato hex) por los de tu organización.

---

## 📂 Estructura del proyecto

```
voluntariando/
├── src/
│   └── worker.js          Servidor: API que filtra datos y verifica permisos
├── public/
│   └── index.html         La página (interfaz de usuario)
├── wrangler.toml          Configuración de Cloudflare
├── package.json           Datos del proyecto
├── .gitignore             Protege archivos sensibles
├── .dev.vars.example      Plantilla de configuración local
└── README.md              Esta guía
```

---

## 🔐 Seguridad y privacidad

- **Base de datos cerrada**: Firestore rechaza todo acceso directo. Solo el Worker entra.
- **Datos sensibles filtrados**: el público solo ve nombres de pila y conteos. Correos y teléfonos solo se entregan a coordinadores autenticados.
- **Secrets fuera del código**: la llave privada vive cifrada en Cloudflare, nunca en GitHub.
- **Validación en el servidor**: el Worker valida cupos, duplicados y permisos. No confía en el navegador.

---

## 📝 Licencia

MIT — úsalo, modifícalo y compártelo libremente. Si te sirve, deja crédito y compártelo con otras comunidades. 💚
