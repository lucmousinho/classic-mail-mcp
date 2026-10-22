# Classic Mail MCP multiusuário: Portainer, Nginx e Claude Team

Este guia sobe **uma** instância do servidor para a empresa inteira. Cada pessoa adiciona (ou recebe, via Claude Team) o mesmo conector, clica em **Conectar**, entra com o **email e a senha da própria caixa na DreamHost** e passa a usar só a própria caixa no Claude: buscar, ler, rascunhar, responder, encaminhar e organizar. Nenhuma senha de email fica na configuração do servidor; o administrador só define quais domínios podem entrar.

Como funciona por baixo, em uma frase: o servidor é o seu próprio "login" (um servidor de autorização OAuth), a prova de identidade é a senha da caixa (verificada uma vez contra `imap.dreamhost.com`), a senha fica cifrada no disco do servidor amarrada àquela pessoa, e cada chamada de ferramenta resolve exclusivamente para a caixa de quem está logado.

Pré-requisitos: host Ubuntu com Docker gerenciado pelo Portainer (standalone), Nginx instalado no host, um subdomínio apontando para o host (aqui `classic-mail.mcp.mambootech.com`), e Python 3 no seu computador para gerar a configuração.

## 1. Configuração (no seu computador, 3 minutos)

```sh
git clone https://github.com/lucmousinho/classic-mail-mcp.git && cd classic-mail-mcp
python3 scripts/setup.py --mode mailbox
```

| Pergunta                                | Resposta                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Allowed email domains                   | `mamboo.co.ao,mamboo.co.tz,mambootech.com`                                   |
| Provider preset                         | `dreamhost`                                                                  |
| IMAP/SMTP hostname e port               | Enter em todos (`imap.dreamhost.com` 993, `smtp.dreamhost.com` 587 STARTTLS) |
| Append sent mail to IMAP?               | `yes`                                                                        |
| sentFolder / draftsFolder / trashFolder | Enter, Enter, Enter (`Sent`, `Drafts`, `Trash`)                              |
| Name shown on the sign-in page          | `Mamboo Mail` (ou o nome que a equipe reconhece)                             |

Sai `.secrets/config.json` (permissão 600) com os domínios, o provedor e três chaves aleatórias. Não há nenhuma senha dentro. Não troque as chaves depois: `encryptionKey` é o que abre as credenciais cifradas de todo mundo (trocar obriga todos a logarem de novo) e `jwtSigningKey` assina os tokens.

## 2. Arquivo no servidor (2 minutos)

```sh
scp .secrets/config.json usuario@SERVIDOR:/tmp/config.json
```

No servidor:

```sh
sudo mkdir -p /opt/classic-mail && sudo chmod 700 /opt/classic-mail
sudo mv /tmp/config.json /opt/classic-mail/config.json
sudo chown 1000:1000 /opt/classic-mail/config.json && sudo chmod 600 /opt/classic-mail/config.json
```

(O container roda como UID 1000 e monta o arquivo somente leitura.)

## 3. Nginx no host e certificado (5 minutos, com o DNS já respondendo)

```sh
dig +short classic-mail.mcp.mambootech.com        # precisa devolver o IP do servidor

sudo curl -fsSL -o /etc/nginx/sites-available/classic-mail.mcp.mambootech.com \
  https://raw.githubusercontent.com/lucmousinho/classic-mail-mcp/main/deploy/nginx/classic-mail.mcp.mambootech.com.conf
sudo ln -s /etc/nginx/sites-available/classic-mail.mcp.mambootech.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d classic-mail.mcp.mambootech.com --redirect --agree-tos -n -m seu-email@example.com
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
grep -n "proxy_read_timeout\|proxy_buffering\|listen 443" /etc/nginx/sites-available/classic-mail.mcp.mambootech.com
```

O que o arquivo garante: `proxy_pass http://127.0.0.1:8080` (o stack prende o container ao loopback, só o Nginx chega nele), `proxy_read_timeout 135s` (chamadas podem levar até 125 s), `proxy_buffering off` e `proxy_cache off` (Streamable HTTP), `proxy_intercept_errors off` (o `401` do servidor leva o ponteiro de descoberta OAuth que o Claude precisa ler), `client_max_body_size 13m` (anexos). No `ufw` só 80 e 443 ficam abertos.

## 4. Stack no Portainer (3 minutos)

Stacks > **Add stack** > nome `classic-mail` > **Repository**:

- Repository URL: `https://github.com/lucmousinho/classic-mail-mcp`
- Reference: `refs/heads/main`
- Compose path: `deploy/portainer/stack-port.yml`

Environment variables:

| Nome          | Valor                                                              |
| ------------- | ------------------------------------------------------------------ |
| `IMAGE`       | `ghcr.io/lucmousinho/classic-mail-mcp:latest`                      |
| `BASE_URL`    | `https://classic-mail.mcp.mambootech.com`                          |
| `CONFIG_FILE` | `/opt/classic-mail/config.json`                                    |
| `AUTH_MODE`   | `mailbox`                                                          |
| `ACCESS_MODE` | `read-write` (leitura e envio; `read-only` deixa só 6 ferramentas) |
| `BIND_PORT`   | `8080`                                                             |

**Deploy the stack**. Em Containers, `classic-mail-mcp` fica _healthy_ em menos de um minuto. Se reiniciar em loop, veja os logs: "Classic Mail could not start" significa `config.json` inválido, não montado ou com UID errado.

Teste pelo terminal:

```sh
curl -s https://classic-mail.mcp.mambootech.com/status
# {"service":"classic-mail-mcp","version":"2.2.0","configured":true,"mailAccess":"requires_oauth","accessMode":"read-write"}
curl -s https://classic-mail.mcp.mambootech.com/.well-known/oauth-authorization-server | head -c 300
# "issuer":"https://classic-mail.mcp.mambootech.com", ... "registration_endpoint": ...
curl -si -X POST https://classic-mail.mcp.mambootech.com/mcp -H 'Content-Type: application/json' -d '{}' | grep -i "HTTP/\|www-authenticate"
# 401 + WWW-Authenticate: Bearer ... resource_metadata=".../.well-known/oauth-protected-resource/mcp"
```

## 5. Conector no Claude Team (administrador, 2 minutos)

1. claude.ai, logado como **Owner/Admin** da organização > **Configurações da organização > Conectores** > **Adicionar conector personalizado**.
2. Nome: `Email empresarial`. URL: `https://classic-mail.mcp.mambootech.com/mcp`.
3. Opções avançadas: deixe **OAuth Client ID** e **Client Secret** em branco (o Claude se registra sozinho no servidor; o servidor só emite clientes públicos com PKCE).
4. Salve. O conector aparece para todos os membros, ainda desconectado.

Para contas individuais (sem Team), cada pessoa faz os mesmos passos em Configurações > Conectores, com a mesma URL.

## 6. O que cada pessoa faz (1 minuto)

1. Configurações > Conectores > `Email empresarial` > **Conectar**.
2. Abre a página do servidor (`Mamboo Mail`), que informa o que o assistente poderá fazer e que o retorno será para `claude.ai`. A pessoa digita o **endereço completo** e a **senha da caixa** (a mesma do webmail/Outlook).
3. O servidor confere na DreamHost e volta para o Claude. Pronto.
4. No chat, com o conector ativo: "liste as contas", "mostre as cinco mensagens mais recentes da INBOX sem marcar como lidas", "liste as pastas" (para confirmar `Sent`/`Drafts`/`Trash`).

Observações para repassar à equipe:

- Só emails dos domínios permitidos entram; `@gmail.com` é recusado antes de qualquer tentativa.
- Cinco senhas erradas em 15 minutos travam o login daquela caixa (proteção contra o bloqueio de IP da DreamHost, que afetaria todos). Espere e tente de novo.
- Quem trocar a senha da caixa precisa **Desconectar** e **Conectar** de novo no Claude.
- Antes de enviar ou excluir, o Claude pede confirmação; ainda assim, a regra é só enviar quando a pessoa pedir explicitamente.

## 7. Administração

Listar quem já se conectou e remover alguém (remoção apaga a credencial cifrada e revoga todos os tokens na hora):

```sh
docker exec classic-mail-mcp node dist/users-cli.js list
docker exec classic-mail-mcp node dist/users-cli.js remove pessoa@mamboo.co.ao
```

Outras rotinas:

- **Backup**: volume `classic_mail_data` (SQLite com usuários cifrados, sessões e histórico de envio) mais `/opt/classic-mail/config.json`. Sem o `config.json` (as chaves) o banco não abre.
- **Atualizar**: push na `main` publica nova imagem; no Portainer, **Re-pull image and redeploy**.
- **Adicionar um domínio**: edite `allowedDomains` em `/opt/classic-mail/config.json` e reinicie o container.
- **Alternar leitura/escrita**: mude `ACCESS_MODE` no stack e **Update the stack**; as pessoas usam **Reconectar** no Claude para a lista de ferramentas atualizar.
- **Logs**: só eventos (`mcp_auth_rejected` com o estágio), nunca senhas, tokens ou conteúdo de email.
- **Limites**: 120 chamadas por minuto por pessoa, 30 envios por hora por pessoa, 4 conexões IMAP simultâneas por pessoa, anexos até 4 MiB, mensagens até 8 MiB.

## Problemas comuns

| Sintoma                                              | Causa provável                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude: "Couldn't reach the MCP server"              | `/.well-known/*` não chega ao container, `401` sem `WWW-Authenticate` (proxy removendo cabeçalhos), ou WAF bloqueando a faixa da Anthropic `160.79.104.0/21` |
| Claude: "Authorization with the MCP server failed"   | `BASE_URL` diferente do domínio real (compare com o `issuer` do `/.well-known/oauth-authorization-server`)                                                   |
| Página de login diz "domain is not allowed"          | Domínio fora de `allowedDomains`                                                                                                                             |
| Página diz "rejected this email address or password" | Senha errada, ou IP do servidor temporariamente bloqueado pela DreamHost após falhas em sequência                                                            |
| Página diz "Too many sign-in attempts"               | 5 tentativas em 15 min para aquela caixa (ou 20 por IP de origem na hora); espere                                                                            |
| Enviou mas não apareceu em `Sent`                    | Nome da pasta diferente na caixa; ajuste `sentFolder` no `config.json` e reinicie                                                                            |
| Container reinicia em loop                           | `config.json` inválido ou não montado; verifique com `docker logs classic-mail-mcp`                                                                          |
| Alguém perdeu o acesso de repente                    | Foi removido com `users-cli remove`, ou `encryptionKey`/`jwtSigningKey` mudou; basta Conectar de novo                                                        |

## Modo de um operador (Google)

O modo original do projeto continua disponível: `AUTH_MODE=oauth`, `scripts/setup.py --mode oauth`, um cliente OAuth do Google e um único login permitido com todas as caixas listadas no `config.json`. Serve para uma pessoa só com várias caixas; para equipe use o modo `mailbox` descrito acima. Exemplo de configuração: `deploy/portainer/config.single-operator.example.json`.
