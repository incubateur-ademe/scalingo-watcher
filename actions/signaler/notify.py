"""Previent les canaux configures d'un changement d'etat du parc.

Le script est a part parce qu'il ne tient pas lisiblement dans du YAML : les
guillemets d'un JSON imbrique dans un script shell lui-meme imbrique dans une
etape finissent par se contredire.

Canaux, tous facultatifs et cumulables :
- Teams : webhook Workflows Power Automate, carte adaptative. Les connecteurs
  Office 365 qui n'admettaient que le message card sont hors service depuis
  mai 2026.
- Webhook au format Slack ({"text": ...}) : Slack, Mattermost, Rocket.Chat, et
  Tchap via une passerelle comme betagouv/slack2tchap.
- Matrix : envoi direct dans un salon avec le jeton d'un compte bot. Tchap n'a
  pas de webhook entrant, c'est la voie sans passerelle.

Un canal en echec produit un avertissement sans faire echouer le job : le
tableau de bord est deja a jour, et un canal en panne ne doit pas masquer les
autres.
"""

import html
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

TITLES = {
    "opened": "Suivi du parc Scalingo ouvert",
    "changed": "L'etat du parc a change",
    "resolved": "Le parc est revenu a la normale",
}

state = os.environ["STATE"]
title = TITLES.get(state, "Etat du parc")
run_url = os.environ["RUN_URL"]
repo_url = os.environ["REPO_URL"]
issue = os.environ.get("ISSUE", "").strip()
issue_url = f"{repo_url}/issues/{issue}" if issue else ""

if state == "resolved":
    detail = "Plus rien a signaler sur le parc."
else:
    with open(os.environ["REPORT"], encoding="utf-8") as f:
        report = f.read()
    # Le rapport commence par les tableaux du parc, qui depassent a eux seuls la
    # place d'un message. Ce qui demande une intervention suit le marqueur
    # d'etat : c'est cette partie qui est envoyee.
    marker = re.search(r"<!-- etat: [a-z]+ -->\s*", report)
    action = report[marker.end():] if marker else report
    detail = action.strip()[:1200].strip() or "Aucun detail."

links = [(label, url) for label, url in (("Tableau de bord", issue_url), ("Execution", run_url)) if url]


def post(name, url, payload, method="POST", headers=None):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"{name} prevenu ({response.status})")
            return True
    except urllib.error.HTTPError as e:
        print(f"::warning::notification {name} en echec ({e.code}) : {e.read()[:300].decode(errors='replace')}")
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"::warning::notification {name} en echec : {e}")
    return False


def teams(webhook):
    card = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
            {
                "type": "TextBlock",
                "text": title,
                "weight": "Bolder",
                "size": "Medium",
                "wrap": True,
                "color": "Good" if state == "resolved" else "Attention",
            },
            {"type": "TextBlock", "text": detail, "wrap": True},
        ],
        "actions": [{"type": "Action.OpenUrl", "title": label, "url": url} for label, url in links],
    }
    payload = {
        "type": "message",
        "attachments": [
            {"contentType": "application/vnd.microsoft.card.adaptive", "contentUrl": None, "content": card}
        ],
    }
    return post("Teams", webhook, payload)


# Les URL nues plutot qu'une syntaxe de lien : Slack (<url|texte>) et Mattermost
# ([texte](url)) ne s'accordent pas, et une passerelle ne garantit ni l'une ni
# l'autre.
def slack(webhook):
    text = "\n".join([f"*{title}*", "", detail, "", *[f"{label} : {url}" for label, url in links]])
    return post("webhook Slack", webhook, {"text": text})


def matrix(homeserver, room, token):
    body = "\n".join([title, "", detail, "", *[f"{label} : {url}" for label, url in links]])
    formatted = (
        f"<p><strong>{html.escape(title)}</strong></p>"
        f"<pre>{html.escape(detail)}</pre>"
        + "<p>"
        + " | ".join(f'<a href="{html.escape(url)}">{html.escape(label)}</a>' for label, url in links)
        + "</p>"
    )
    # Identifiant de transaction stable par execution et par etat : un nouvel
    # essai du job n'envoie pas deux fois le meme message.
    txn = f"scalingo-watcher-{os.environ.get('GITHUB_RUN_ID', '0')}-{os.environ.get('GITHUB_RUN_ATTEMPT', '1')}-{state}"
    url = (
        f"{homeserver.rstrip('/')}/_matrix/client/v3/rooms/{urllib.parse.quote(room, safe='')}"
        f"/send/m.room.message/{urllib.parse.quote(txn, safe='')}"
    )
    payload = {"msgtype": "m.text", "body": body, "format": "org.matrix.custom.html", "formatted_body": formatted}
    return post("Matrix", url, payload, method="PUT", headers={"Authorization": f"Bearer {token}"})


sent = 0
if os.environ.get("TEAMS_WEBHOOK"):
    sent += teams(os.environ["TEAMS_WEBHOOK"])
if os.environ.get("SLACK_WEBHOOK"):
    sent += slack(os.environ["SLACK_WEBHOOK"])
matrix_config = [os.environ.get(k, "").strip() for k in ("MATRIX_HOMESERVER", "MATRIX_ROOM_ID", "MATRIX_ACCESS_TOKEN")]
if all(matrix_config):
    sent += matrix(*matrix_config)
elif any(matrix_config):
    print("::warning::configuration Matrix incomplete : homeserver, salon et jeton sont tous trois requis")

if sent == 0:
    print("aucun canal de notification prevenu")
