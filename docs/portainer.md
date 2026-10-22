# Subindo o Classic Mail MCP no Portainer e conectando ao Claude

Este guia cobre o caminho completo: imagem, configuração privada, stack no Portainer, proxy HTTPS, cliente OAuth no Google e o conector personalizado no claude.ai. Ao final o Claude (web, Desktop, mobile e Claude Code) acessa a caixa de email da DreamHost com as mesmas operações do conector do Gmail: buscar, ler, rascunhar, responder, encaminhar e organizar.

Tempo estimado: 40 a 60 minutos na primeira vez. Pré-requisitos:

- Um host Docker gerenciado pelo Portainer (Docker standalone; em Swarm o `read_only`, `tmpfs` e bind mounts se comportam diferente).
- Um proxy HTTPS já funcionando nesse host (Traefik, Nginx Proxy Manager, Caddy ou Cloudflare Tunnel) com certificado válido.
- Um subdomínio apontando para o host, por exemplo `mail-mcp.seudominio.com`.
- Acesso ao Google Cloud Console com a conta Google que vai fazer o login (pode ser a conta Workspace da empresa).
- Python 3 no seu computador para rodar o assistente de configuração.

Um ponto de atenção antes de começar: o arquivo `config.json` guarda a senha da caixa de email em texto puro. Ele deve ficar só no host, com permissão `600`, fora do Git e nunca colado no Portainer, no Claude ou em chats.

## 1. Publique a imagem do seu fork

O stack do Portainer puxa a imagem do GitHub Container Registry. O workflow `.github/workflows/docker-publish.yml` já faz isso a cada push na branch `main`.

1. Faça push deste repositório para o seu GitHub (fork ou repositório próprio).
2. Em **Actions**, confirme que o workflow **Publish image** terminou. A imagem fica em `ghcr.io/SEU-USUARIO/classic-mail-mcp:latest`.
3. Em **Packages** (perfil do GitHub) abra `classic-mail-mcp` > **Package settings** > **Change visibility** > Public. Alternativa: deixe privado e cadastre um registry `ghcr.io` no Portainer (Registries > Add registry > Custom, usuário do GitHub + token com escopo `read:packages`).

Sem GitHub Actions, você pode construir no próprio host: `docker build -t classic-mail-mcp:local .` e usar `IMAGE=classic-mail-mcp:local` no stack.

## 2. Crie o cliente OAuth no Google

O login no Google serve só para provar **quem é você** para o servidor MCP. Ele não dá acesso ao Gmail e não tem relação com a caixa da DreamHost.

1. Google Cloud Console > crie ou escolha um projeto.
2. **APIs e serviços > Tela de consentimento OAuth** (Google Auth Platform). Tipo de público: **Interno** se a conta de login for de um domínio Google Workspace (recomendado: evita a expiração de 7 dias dos refresh tokens que existe no modo "Externo/Teste"). Se for `@gmail.com`, escolha Externo e publique o app, ou aceite reconectar a cada 7 dias.
3. **Credenciais > Criar credenciais > ID do cliente OAuth > Aplicativo da Web**.
4. URI de redirecionamento autorizado, exatamente: `https://mail-mcp.seudominio.com/oauth/callback`.
5. Guarde o **ID do cliente** (termina em `.apps.googleusercontent.com`) e o **segredo**. O segredo vai apenas no `config.json` do servidor, nunca no Claude.

## 3. Gere o `config.json` no seu computador

Na pasta do repositório:

```sh
python3 scripts/setup.py --mode oauth
```

Respostas para uma caixa da DreamHost:

| Pergunta                                | Resposta                                                                |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Number of mailboxes                     | `1` (até 10 caixas por instância)                                       |
| Short account ID                        | `empresa` (ou outro nome curto; é como o Claude vai se referir à conta) |
| Provider preset                         | `dreamhost`                                                             |
| Email address                           | `contato@example.com`                                                   |
| IMAP username                           | Enter (usa o endereço completo)                                         |
| Mailbox / app password                  | a senha da caixa no painel da DreamHost (**Manage Email**)              |
| IMAP hostname / port                    | Enter, Enter (`imap.dreamhost.com`, 993)                                |
| SMTP hostname / port                    | Enter, Enter (`smtp.dreamhost.com`, 587 com STARTTLS)                   |
| Append sent mail to IMAP?               | `yes`                                                                   |
| sentFolder / draftsFolder / trashFolder | Enter, Enter, Enter (`Sent`, `Drafts`, `Trash`)                         |
| Separate SMTP credentials?              | `no`                                                                    |
| Google OAuth WEB client ID              | o ID do passo 2                                                         |
| Google OAuth WEB client secret          | o segredo do passo 2                                                    |
| ONE Google sign-in email                | a conta Google que vai clicar em "Conectar" no Claude                   |

O arquivo sai em `.secrets/config.json` com permissão 600 e chaves aleatórias já geradas. Não edite as três chaves (`jwtSigningKey`, `encryptionKey`, `consentSigningKey`); trocá-las depois invalida sessões e o histórico de envio.

Valide o arquivo antes de subir. O comando checa o schema e faz **um** login IMAP e **um** login SMTP na DreamHost (sem enviar nada), o que evita gastar tentativas e tomar bloqueio de IP por senha errada:

```sh
npm ci && npm run build
npm run verify < .secrets/config.json
# {"account":"empresa","protocol":"imap","ok":true}
# {"account":"empresa","protocol":"smtp","ok":true}
```

## 4. Coloque o arquivo no host

No host Docker, como root ou com `sudo`:

```sh
sudo mkdir -p /opt/classic-mail
sudo chmod 700 /opt/classic-mail
# copie o arquivo (scp, sftp, rsync) para /opt/classic-mail/config.json
sudo chown 1000:1000 /opt/classic-mail/config.json
sudo chmod 600 /opt/classic-mail/config.json
```

O container roda como o usuário `node` (UID 1000) e monta o arquivo somente leitura. Se o seu host usa outro UID para o Docker, ajuste o `chown`.

## 5. Crie o stack no Portainer

Portainer > **Stacks > Add stack**. Dê o nome `classic-mail`.

**Origem do compose**, escolha uma:

- **Repository**: URL do seu fork, branch `main`, _Compose path_ `deploy/portainer/stack-traefik.yml` (ou `stack-port.yml`). Ative _GitOps updates_ se quiser que o Portainer reaplique o stack quando a branch mudar.
- **Web editor**: cole o conteúdo do arquivo de stack.

**Environment variables** (aba do stack):

| Variável          | Valor                                                        |
| ----------------- | ------------------------------------------------------------ |
| `IMAGE`           | `ghcr.io/SEU-USUARIO/classic-mail-mcp:latest`                |
| `BASE_URL`        | `https://mail-mcp.seudominio.com` (sem barra no final)       |
| `MCP_HOST`        | `mail-mcp.seudominio.com` (só no stack Traefik)              |
| `CONFIG_FILE`     | `/opt/classic-mail/config.json`                              |
| `ACCESS_MODE`     | `read-only` (troque para `read-write` só depois dos testes)  |
| `TRAEFIK_NETWORK` | nome da rede do Traefik, ex.: `traefik_public` (só Traefik)  |
| `CERT_RESOLVER`   | nome do resolver do Traefik, ex.: `letsencrypt` (só Traefik) |
| `BIND_PORT`       | `8080` (só no stack de porta)                                |

Clique em **Deploy the stack**. Em **Containers**, `classic-mail-mcp` deve ficar _healthy_ em menos de um minuto. Se ficar reiniciando, abra os logs: a mensagem "Classic Mail could not start" indica `config.json` inválido ou não montado (valores nunca são logados).

### Proxy HTTPS

O serviço precisa que o proxy:

- repasse os cabeçalhos `Authorization`, `WWW-Authenticate` e cookies sem alterar;
- não faça cache de `/mcp`, `/oauth/*` e `/.well-known/*`;
- aceite respostas lentas: timeout de leitura de pelo menos **130 segundos**;
- envie o `Host` original.

Traefik: as labels do `stack-traefik.yml` resolvem tudo; só confirme que o entrypoint `websecure` e o certresolver existem na sua instalação.

**Nginx instalado no próprio host Ubuntu + certbot** (use o `stack-port.yml`, que publica o container em `127.0.0.1:8080`):

```sh
# 1. DNS: crie um registro A (e AAAA, se tiver IPv6) para o host, ex.: classic-mail.mcp.mambootech.com → IP do servidor
#    Confirme antes de pedir o certificado:
dig +short classic-mail.mcp.mambootech.com

# 2. Instale o site (o arquivo pronto está em deploy/nginx/ dentro do repositório)
sudo curl -fsSL -o /etc/nginx/sites-available/classic-mail.mcp.mambootech.com \
  https://raw.githubusercontent.com/SEU-USUARIO/classic-mail-mcp/main/deploy/nginx/classic-mail.mcp.mambootech.com.conf
sudo ln -s /etc/nginx/sites-available/classic-mail.mcp.mambootech.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 3. Certificado (instala o certbot se ainda não existir)
sudo apt-get install -y certbot python3-certbot-nginx   # ou: sudo snap install --classic certbot
sudo certbot --nginx -d classic-mail.mcp.mambootech.com --redirect -m seu-email@example.com --agree-tos -n
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run   # confirma a renovação automática (timer do systemd)

# 4. Confira que o certbot não mexeu no location: proxy_read_timeout/proxy_buffering precisam continuar lá
grep -n "proxy_read_timeout\|proxy_buffering\|listen 443" /etc/nginx/sites-available/classic-mail.mcp.mambootech.com
```

Para outro domínio, troque o `server_name` e o nome do arquivo; o restante do bloco não muda. Se o host tem `ufw`, só 80 e 443 precisam estar abertos; a porta 8080 fica presa em `127.0.0.1` pelo próprio stack.

Nginx Proxy Manager: crie um Proxy Host para `mail-mcp.seudominio.com` apontando para `http://127.0.0.1:8080` (stack de porta) ou `http://classic-mail-mcp:8080` (se o NPM estiver na mesma rede Docker), ative **Force SSL** e **HTTP/2**, e na aba **Advanced** cole:

```nginx
proxy_read_timeout 135s;
proxy_send_timeout 135s;
proxy_buffering off;
proxy_cache off;
proxy_set_header Authorization $http_authorization;
proxy_pass_header WWW-Authenticate;
```

Caddy: `mail-mcp.seudominio.com { reverse_proxy 127.0.0.1:8080 }` já é suficiente.

Cloudflare Tunnel: aponte o hostname público para `http://classic-mail-mcp:8080` ou `http://127.0.0.1:8080`; em **Cloudflare > Caching**, crie uma regra de _Bypass cache_ para esse host. Se usar Cloudflare Access ou WAF na frente, libere a faixa de saída da Anthropic `160.79.104.0/21`, senão o Claude não consegue nem ler a descoberta OAuth.

### Teste do servidor

No seu computador:

```sh
curl -s https://mail-mcp.seudominio.com/status
# {"service":"classic-mail-mcp","version":"2.1.0","configured":true,"mailAccess":"requires_oauth","accessMode":"read-only"}

curl -s https://mail-mcp.seudominio.com/.well-known/oauth-protected-resource/mcp
# {"resource":"https://mail-mcp.seudominio.com/mcp","authorization_servers":["https://mail-mcp.seudominio.com"],...}

curl -si -X POST https://mail-mcp.seudominio.com/mcp -H 'Content-Type: application/json' -d '{}' | head -5
# HTTP/2 401 ... WWW-Authenticate: Bearer ... resource_metadata="https://mail-mcp.seudominio.com/.well-known/oauth-protected-resource/mcp"
```

Se o `401` vier sem `WWW-Authenticate`, o proxy está removendo cabeçalhos. Se o `resource` não for exatamente a URL `/mcp`, confira `BASE_URL`.

## 6. Conecte no Claude

1. claude.ai > **Configurações > Conectores > Adicionar conector personalizado**.
2. Nome: `Email empresarial`. URL: `https://mail-mcp.seudominio.com/mcp`.
3. Em opções avançadas, deixe **OAuth Client ID** e **Client Secret** em branco. O servidor registra o Claude sozinho (Dynamic Client Registration). Nunca cole aqui o segredo do Google.
4. Clique em **Adicionar** e depois em **Conectar**. Abre a tela do servidor, depois o login do Google; use exatamente a conta listada em `allowedEmails`. A tela de consentimento mostra que o retorno será para `claude.ai`.
5. De volta ao chat, ative o conector no menu de ferramentas e peça:
   - "Liste as contas disponíveis no Email empresarial."
   - "Verifique a conexão da conta empresa." (faz login IMAP e SMTP sem enviar nada)
   - "Mostre as cinco mensagens mais recentes da INBOX sem marcar como lidas."
   - "Liste as pastas da conta empresa." e compare com `Sent`, `Drafts`, `Trash`.

No Claude Desktop e no app móvel o conector aparece automaticamente, pois é o mesmo cadastro. No Claude Code, rode `claude mcp add --transport http email-empresarial https://mail-mcp.seudominio.com/mcp` e autentique com `/mcp`; o retorno usa uma porta local (`http://localhost:PORTA/callback`), que o servidor já aceita.

## 7. Liberando envio e gerenciamento

Depois de alguns dias em leitura, mude `ACCESS_MODE` para `read-write` nas variáveis do stack e clique em **Update the stack**. Em seguida, no claude.ai, abra o conector e use **Reconectar** (ou remova e adicione de novo) para que a lista de 21 ferramentas apareça. Com escrita habilitada:

- O Claude pede confirmação antes de enviar e de excluir, mas essa confirmação é do cliente, não do servidor. Mantenha a regra de só enviar quando você pedir explicitamente.
- Envio usa chave de idempotência: se uma chamada der timeout, peça para o Claude inspecionar a pasta `Sent` antes de tentar de novo.
- Exclusão permanente exige confirmação explícita e só acontece com UIDPLUS; mover para `Trash` é o caminho normal.

## Operação

- **Backup**: o volume `classic_mail_data` guarda o SQLite com sessões OAuth e o histórico de envio (endereços e message IDs). Faça backup criptografado junto com `/opt/classic-mail/config.json`.
- **Atualizar**: novo push na `main` publica nova imagem; no Portainer use **Re-pull image and redeploy**.
- **Trocar a senha da caixa**: edite `/opt/classic-mail/config.json` no host e reinicie o container. Lembre que a DreamHost bloqueia o IP após várias falhas de login.
- **Revogar o acesso do Claude**: remova o conector no claude.ai e, se quiser forçar, troque `jwtSigningKey` no `config.json` (invalida todos os tokens emitidos).
- **Várias pessoas**: uma instância atende um operador. Para outra pessoa, suba um segundo stack com outro subdomínio, outro `config.json` e outro volume.
- **Logs**: o container registra apenas eventos como `mcp_auth_rejected` com o estágio da falha; nunca senhas, tokens ou corpos de email.

## Problemas comuns

| Sintoma                                            | Causa provável                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Claude: "Couldn't reach the MCP server"            | `/.well-known/*` não chega ao container, `401` sem `WWW-Authenticate` ou WAF bloqueando a Anthropic       |
| Claude: "Authorization with the MCP server failed" | `BASE_URL` diferente do domínio real, redirect URI errado no Google, conta Google fora de `allowedEmails` |
| Login do Google: `redirect_uri_mismatch`           | URI no Google precisa ser exatamente `https://SEU-HOST/oauth/callback`                                    |
| `invalid_redirect_uri` na tela do servidor         | Cliente usando callback que não é do Claude, do ChatGPT nem loopback local                                |
| `check_connection` falha só no IMAP                | Senha errada ou IP bloqueado pela DreamHost; aguarde e confira a senha em **Manage Email**                |
| Enviou, mas não aparece em `Sent`                  | Nome da pasta diferente; liste as pastas e ajuste `sentFolder`                                            |
| Conector some ou pede login a cada 7 dias          | App OAuth do Google em modo "Teste" com público Externo; use Interno ou publique o app                    |
| Container reinicia em loop                         | `config.json` inválido, não montado ou com UID errado; valide com `npm run verify`                        |
