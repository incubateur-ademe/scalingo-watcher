# Accès Scalingo par le proxy

En accès par proxy, le dépôt du parc ne détient aucun jeton Scalingo. Il porte
`fgp.json`, qui liste des blobs, et un secret `FGP_KEY`. Un blob est une
configuration chiffrée : sans la clé il ne sert à rien, ce qui permet de le
versionner.

Chaque blob borne ce que la clé autorise à une méthode et un chemin. Le proxy
renouvelle de son côté le jeton porteur, valable une heure, et pour les
sauvegardes il obtient le jeton d'addon, valable une heure lui aussi. Le watcher
ne voit jamais ni l'un ni l'autre.

L'adresse du proxy est le champ `url` de `fgp.json`. Absent, le moteur prend
`https://fgp.incubateur.ademe.fr`.

## Générer les blobs

Le script d'amorçage lit le manifeste, retrouve l'identifiant d'addon de chaque
application et produit `fgp.json` d'un coup. Il se lance depuis la racine du
dépôt du parc, une fois le manifeste écrit :

```bash
export SCALINGO_API_TOKEN=tk-us-xxxxxxxx
export FGP_KEY='<la cle que tu choisis>'
node <outil>/src/fgp-blobs.ts --dry-run   # montre ce qui serait genere
node <outil>/src/fgp-blobs.ts             # ecrit fgp.json
```

Le proxy visé est `--url`, sinon la variable `FGP_URL`, sinon celui du
`fgp.json` existant, sinon le proxy par défaut. Il doit être servi en https.
`--manifest` et `--fgp` désignent d'autres fichiers que ceux du répertoire
courant. Un `fgp.json` existant est copié dans `--out-dir` avant d'être
remplacé.

C'est le seul moment où le jeton de compte est manipulé : il part chiffré dans
les blobs et n'a plus à exister ensuite, ni dans le dépôt ni dans les secrets.
Relancer le script régénère tout, ce qu'il faut faire pour changer de clé.

Il faut un blob d'API par région du manifeste, et un blob de sauvegarde par
application qui a une base, le mode `scalingo-addon` figeant l'app et l'addon
dans le blob. Ajouter une application au manifeste demande donc de relancer le
script.

La clé va ensuite en secret de l'environment que déclarent les workflows. Le
script affiche la commande, qui vise le dépôt du remote `origin` :

```bash
gh secret set FGP_KEY --env production --repo <owner>/<depot>
```

## À la main

Choisis une clé une fois pour toutes, entre 24 et 256 caractères ASCII
imprimables sans espace, et réutilise-la pour chaque blob. C'est elle, et elle
seule, qui va dans les secrets du dépôt.

```bash
export FGP=https://fgp.incubateur.ademe.fr
export FGP_KEY='<ta cle>'
export TK='tk-us-xxxxxxxx'
```

Un blob par région pour l'API principale :

```bash
for region in osc-fr1 osc-secnum-fr1; do
  curl -sX POST "$FGP/api/generate" -H 'Content-Type: application/json' -d "{
    \"token\": \"$TK\",
    \"target\": \"https://api.$region.scalingo.com\",
    \"auth\": \"scalingo-exchange\",
    \"key\": \"$FGP_KEY\",
    \"ttl\": 0,
    \"name\": \"api $region\",
    \"scopes\": [
      \"GET:/v1/apps\",
      \"GET:/v1/apps/*\",
      \"GET:/v1/features/stacks\",
      \"POST:/v1/apps/*/deployments\",
      \"POST:/v1/apps/*/variables\",
      \"PATCH:/v1/apps/*/variables/*\"
    ]
  }" | python3 -c "import json,sys; print('$region', json.load(sys.stdin)['blob'])"
done
```

Un blob par application pour ses bases, le mode `scalingo-addon` liant le blob
à une base précise :

```bash
curl -sX POST "$FGP/api/generate" -H 'Content-Type: application/json' -d "{
  \"token\": \"$TK\",
  \"target\": \"https://db-api.osc-fr1.scalingo.com\",
  \"auth\": {
    \"type\": \"scalingo-addon\",
    \"app\": \"alpha-metabase\",
    \"addonId\": \"ad-xxxx\",
    \"apiUrl\": \"https://api.osc-fr1.scalingo.com\"
  },
  \"key\": \"$FGP_KEY\",
  \"ttl\": 0,
  \"name\": \"sauvegarde alpha-metabase\",
  \"scopes\": [
    \"GET|POST:/api/databases/*/backups\",
    \"GET:/api/databases/*\",
    \"POST:/api/databases/*/upgrade\",
    \"GET:/api/database_type_versions/*\",
    \"GET:/api/operations/*\"
  ]
}" | python3 -c "import json,sys; print(json.load(sys.stdin)['blob'])"
```

L'identifiant d'addon se lit avec `scalingo --region <region> --app <app> addons`.

Le champ `apiUrl` n'est pas facultatif en pratique : sans lui, le proxy cherche
l'addon sur sa région par défaut, `osc-fr1`. Un blob généré sans ce champ pour
une application d'une autre région échoue en `auth_addon_failed`, avec un
message qui ne désigne pas la cause.

Le fichier assemble les blobs par région et par application :

```json
{
  "url": "https://fgp.incubateur.ademe.fr",
  "api": { "osc-fr1": "<blob>", "osc-secnum-fr1": "<blob>" },
  "backup": { "osc-fr1/alpha-metabase": "<blob>" }
}
```

## Lire les journaux

Le script génère les blobs avec la capture activée. Elle porte sur le **body des
requêtes uniquement**, jamais sur les réponses : celles de `/variables`
contiennent tout l'environnement d'une application en clair et ne sont donc
jamais enregistrées. Le body est chiffré avec la clé avant d'être mis en
mémoire, le serveur ne peut pas le lire.

L'interface web est à `<url du proxy>/logs`. En ligne de commande, un flux par
blob :

```bash
FGP=$(python3 -c "import json;print(json.load(open('fgp.json')).get('url','https://fgp.incubateur.ademe.fr'))")
BLOB=$(python3 -c "import json;print(json.load(open('fgp.json'))['api']['osc-fr1'])")
curl -N -H "X-FGP-Key: $FGP_KEY" -H "X-FGP-Blob: $BLOB" "$FGP/logs/stream"
```

Chaque blob porte un nom (`api osc-fr1`, `sauvegarde alpha-metabase`) pour s'y
retrouver dans l'interface. Les tampons sont en mémoire et purgés après dix
minutes sans activité : c'est fait pour observer une exécution, pas pour
archiver.

`fgp-blobs.ts --no-logs` régénère sans capture.

## Ce que la clé ne peut pas faire

Aucun `DELETE`, donc ni application, ni addon, ni variable supprimables. Pas de
création d'application, pas de changement de stack ni de renommage, pas de
scale, pas de redémarrage. Une clé qui fuite permet de lire, de poser une
variable de version, de déployer, de sauvegarder une base et de la monter d'une
version, rien d'autre.

## Durée de vie

Les blobs sont générés sans expiration. Un blob qui expire casserait la chaîne
un matin sans prévenir, et la révocation se fait de toute façon en changeant la
clé : régénère les blobs avec une nouvelle clé et remplace le secret.

## Sans proxy

Si `FGP_KEY` est absente ou `fgp.json` introuvable, le watcher passe en direct
par `SCALINGO_API_TOKEN`, avec tout le pouvoir du compte. Les deux modes
fonctionnent en local comme dans les workflows : c'est le secret posé dans
l'environment qui décide.
