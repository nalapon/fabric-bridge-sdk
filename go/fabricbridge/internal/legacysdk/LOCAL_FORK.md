## Local Fork

Este directorio contiene una copia internalizada de `https://github.com/nalapon/fabric-sdk-go`.

Objetivo:
- eliminar el `replace` del módulo principal
- evitar dependencia operativa de un fork externo
- mantener la capa legacy necesaria para peer targeting dentro del propio SDK

Notas:
- el código se importa localmente con el prefijo `github.com/kolokium/fabric-bridge-go/fabricbridge/internal/legacysdk/...`
- se eliminaron los archivos `go.mod` y `go.sum` del fork para integrarlo en el módulo principal
- se eliminaron los `*_test.go` del fork internalizado para que `go test ./...` del módulo principal no ejecute ni valide la suite upstream
- se aplicaron parches mínimos de compatibilidad para pasar `go vet` bajo el toolchain actual
