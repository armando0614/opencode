# Guía de instalación local

Esta guía explica cómo clonar el repositorio, preparar el entorno y arrancar
OpenCode Desktop en una máquina nueva siguiendo la rama de trabajo
`armando0614/feat/browser-preview`.

## 1. Requisitos previos

- **Node.js** 22 LTS o superior.
- **Bun** 1.3.x como gestor de paquetes (la versión está fijada en
  `package.json` con `packageManager`).
- **Git** con acceso al repositorio.
- En Windows se recomienda usar **PowerShell 7** o **Windows Terminal** para
  evitar problemas con rutas y finales de línea.
- Para empaquetar la app de escritorio se necesitan las
  dependencias opcionales nativas listadas en
  `packages/desktop/optionalDependencies` (por ejemplo
  `@lydell/node-pty-win32-x64`).

## 2. Clonar y cambiar a la rama de trabajo

```bash
git clone https://github.com/<owner>/opencode.git
cd opencode
git fetch origin
git checkout armando0614/feat/browser-preview
git pull --rebase
```

Si ya tienes el repositorio clonado en otro equipo, actualiza la rama:

```bash
git fetch origin
git switch armando0614/feat/browser-preview
git pull --rebase
```

## 3. Instalar dependencias

```bash
bun install
```

Esto instala todos los workspaces definidos en `package.json`
(`packages/*`, `packages/console/*`, `packages/stats/*`, etc.).

## 4. Regenerar el grafo de conocimiento

El repositorio incluye un grafo en `graphify-out/` que se mantiene al día
ejecutando:

```bash
graphify update .
```

Si `graphify` no está instalado globalmente:

```bash
bun add -g graphify
```

`graphify update .` es seguro de reejecutar; solo actualiza
`graphify-out/graph.json` y los índices auxiliares. Si la primera
ejecución se interrumpe, vuélvela a correr.

## 5. Configurar el provider de modelos

Crea o edita `~/.config/opencode/opencode.json` con el provider que prefieras.
Ejemplo mínimo con NVIDIA NIM (compatible con la API de OpenAI):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "nvidia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA NIM (Clave API de NVIDIA)",
      "options": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "{env:NVIDIA_API_KEY}"
      },
      "models": {
        "deepseek-ai/deepseek-v4-flash-free": {
          "name": "DeepSeek V4 Flash Free"
        }
      }
    }
  },
  "model": "nvidia/deepseek-ai/deepseek-v4-flash-free"
}
```

Notas:

- Reemplaza `NVIDIA_API_KEY` por tu variable de entorno real. Cualquier
  referencia `{env:VAR}` se sustituye desde el entorno del sistema.
- En Windows puedes definir la variable con
  `setx NVIDIA_API_KEY "tu-clave"` y reiniciar la terminal.
- Para Anthropic, OpenAI o GitHub Copilot usa la configuración equivalente
  documentada en `packages/opencode` y exporta la variable de entorno
  correspondiente (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GITHUB_TOKEN`, etc.).

## 6. Arrancar OpenCode Desktop en modo desarrollo

Desde la raíz del repositorio:

```bash
bun run dev:desktop
```

El script ejecuta `packages/desktop/scripts/predev.ts` (copia iconos y
construye el binario de `packages/opencode` con
`bun script/build-node.ts`) y luego lanza `electron-vite dev`. La primera
ejecución puede tardar varios minutos mientras se compilan los binarios
nativos.

Si la caché de Vite se corrompe, limpia y reinicia:

```bash
Remove-Item packages/desktop/node_modules/.vite -Recurse -Force
Remove-Item packages/app/node_modules/.vite -Recurse -Force
bun run dev:desktop
```

## 7. Verificación rápida

1. La app debe abrir una ventana de Electron con la UI de OpenCode.
2. Crea o abre una sesión y verifica que el selector de modelo muestra
   el provider configurado (por ejemplo "DeepSeek V4 Flash Free").
3. Escribe un prompt y envíalo; debería persistir la selección aunque
   recargues la app.

## 8. Solución de problemas frecuentes

- **`Cannot read properties of undefined (reading 'browserPreview')` en
  el renderer**: la caché de Vite está sucia. Aplica la limpieza del
  paso 6.
- **Errores de `node-pty` o `parcel-watcher` al instalar**: asegúrate de
  tener las dependencias opcionales nativas listadas en
  `packages/desktop/optionalDependencies`; en Windows se instalan
  automáticamente al ejecutar `bun install`.
- **Provider no aparece en el selector**: revisa
  `~/.config/opencode/opencode.json` y que la API key esté disponible
  en el entorno con `echo $NVIDIA_API_KEY` (PowerShell:
  `Write-Output $env:NVIDIA_API_KEY`).
- **Typecheck falla en `packages/app/src/custom-elements.d.ts`**:
  regenera el grafo con `graphify update .` y vuelve a correr
  `bun run typecheck` desde `packages/desktop`.
