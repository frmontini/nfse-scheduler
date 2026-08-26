# Third-party notices

## Sutil/Emissor-NFS-e-bot

Partes da automação de navegador e alguns seletores do Emissor Nacional foram adaptados do projeto público:

- https://github.com/Sutil/Emissor-NFS-e-bot
- Licença: MIT
- Copyright (c) 2026 Eduardo Sutil

A licença original está em `licenses/Sutil-Emissor-NFS-e-bot-LICENSE.txt`.

## Outras referências de interoperabilidade

Os seguintes projetos públicos foram consultados para entender comportamento do portal, consulta e arquivamento. Nenhum código deles foi copiado para este projeto quando a licença não estava declarada:

- https://github.com/cleitonleonel/emissor_nfse
- https://github.com/kursku/emissor-nfse

O primeiro foi usado apenas como referência de comportamento/protocolo observável do portal (login por CNPJ/senha, consulta e páginas de impressão). O segundo serviu como referência conceitual para idempotência, fila e histórico.

## Conferência de seletores

Em 26/08/2026 os seletores da Emissão Completa foram conferidos contra o `Sutil/Emissor-NFS-e-bot` (commit de 25/08/2026, licença MIT). O resultado está na seção *Conferência contra os projetos de referência* do README, incluindo a lista dos campos que não têm respaldo na referência.

As rotas de consulta/arquivamento foram comparadas com o comportamento observável descrito em `cleitonleonel/emissor_nfse` (sem cópia de código, já que o repositório não declara licença).
