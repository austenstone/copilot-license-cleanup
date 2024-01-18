# Copilot License Management

Run this action on a schedule to automatically remove inactive Copilot licenses. It also creates a report as a job summary and csv.

In addition to this it can also deploy users from a CSV file.  This is useful as you are adopting Copilot as it can help facilitate the process of adding users to your organization.

## Usage
Create a workflow (eg: `.github/workflows/copilot-license-management.yml`). See [Creating a Workflow file](https://help.github.com/en/articles/configuring-a-workflow#creating-a-workflow-file).

### Deploying users from a CSV file

If you want to deploy users from a CSV file you will need to create a CSV file with the following columns:
- `organization` - The organization to add the user to
- `deployment_group` - An arbitrary group name used to track the deployments
- `login` - The user's GitHub Login name to add
- `activation_date` - The date the user should be activated (YYYY-MM-DD)

Example:

```csv
organization,deployment_group,login,activation_date
exampleorg1,group1,octocat,2024-01-15
exampleorg1,group1,octodog,2024-01-15
```

This requires the users to already exist as members of the enterprise and target organization.

If you are using Enterprise Managed Users, it may be easier to use a group from your identity provider to manage the users.  You can assign the group to a team in an organization and assign that team to Copilot.  This will allow you to manage the users in your identity provider and have them automatically added/removed from Copilot as group membership changes.

### PAT(Personal Access Token)

You will need to [create a PAT(Personal Access Token)](https://github.com/settings/tokens/new?scopes=manage_billing:copilot) that has `manage_billing:copilot` access.  If you are specifying an 'enterprise' rather than individual organizations you must also include the `read:org` and `read:enterprise` scopes. 

Add this PAT as a secret `TOKEN` so we can use it for input `github-token`, see [Creating encrypted secrets for a repository](https://docs.github.com/en/enterprise-cloud@latest/actions/security-guides/encrypted-secrets#creating-encrypted-secrets-for-a-repository). 
### Organizations

If your organization has SAML enabled you must authorize the PAT, see [Authorizing a personal access token for use with SAML single sign-on](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on).


#### Example
```yml
name: Cleanup Copilot Licenses
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'

jobs:
  copilot:
    name: Copilot Seats
    runs-on: ubuntu-latest
    steps:
      - uses: austenstone/copilot-license-cleanup@v1.2
        with:
          github-token: ${{ secrets.TOKEN }}
```

#### Example Auto remove
```yml
      - uses: austenstone/copilot-license-cleanup@v1.2
        with:
          github-token: ${{ secrets.TOKEN }}
          remove: true
          remove-from-team: true
```

#### Example Custom days before inactive
```yml
      - uses: austenstone/copilot-license-cleanup@v1.2
        with:
          github-token: ${{ secrets.TOKEN }}
          remove: true
          remove-from-team: true
          inactive-days: 10
```

#### Example Specifying multiple organizations: 
```yml
      - uses: austenstone/copilot-license-cleanup@v1.2
        with:
          github-token: ${{ secrets.TOKEN }}
          organization: exampleorg1, demoorg2, myorg3
```

#### Example specifying a GitHub Enterprise (to run on all organizations in the enterprise):
```yml
      - uses: austenstone/copilot-license-cleanup@v1.2
        with:
          github-token: ${{ secrets.TOKEN }}
          enterprise: octodemo
```

#### Example uploading inactive users JSON artifact (same could be done with deployed-seats)
```yml
      - uses: austenstone/copilot-license-cleanup@v1.2
        id: copilot
        with:
          github-token: ${{ secrets.TOKEN }}
      - name: Save inactive seats JSON to a file
        run: |
          echo '${{ steps.copilot.outputs.inactive-seats }}' | jq . > inactive-seats.json
      - name: Upload inactive seats JSON as artifact
        uses: actions/upload-artifact@v4
        with:
          name: inactive-seats-json
          path: inactive-seats.json
```

#### Example deploying users from a CSV file 

```yml
name: Copilot License Review
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'
jobs:
  copilot:
    name: Copilot Seats
    runs-on: ubuntu-latest
      # Checkout your repo so we can access the CSV file
      - name: Checkout code
        uses: actions/checkout@v4

      - uses: austenstone/copilot-license-cleanup@v1.2
        id: copilot_job
        with:
          organization: octodemo, avocadocorp
          github-token: ${{ secrets.TOKEN }}
          remove: false
          remove-from-team: false
          inactive-days: 30
          deploy-users: true
          csv: true
          # Optional inputs
          deploy-users-dry-run: false    # Default is true
          deploy-users-csv: ./copilot-users.csv
          deploy-validation-time: 3
```

<details>
  <summary>Job summary example</summary>
  
  <img src="https://github.com/austenstone/copilot-license-cleanup/assets/22425467/4695fc23-e9c7-4403-ba04-2de0e2d36242"/>
  
</details>


## ➡️ Inputs
Various inputs are defined in [`action.yml`](action.yml):

| Name | Description | Default |
| --- | - | - |
| **github&#x2011;token** | Token to use to authorize. | ${{&nbsp;github.token&nbsp;}} |
| organization | The organization(s) to use for the action (comma separated)| ${{&nbsp;github.repository_owner&nbsp;}} |
| enterprise | (optional) All organizations in this enterprise (overrides organization) | null |
| remove | Whether to remove inactive users | false |
| remove-from-team | Whether to remove inactive users from their assigning team | false |
| inactive&#x2011;days | The number of days to consider a user inactive | 90 |
| job-summary | Whether to output a summary of the job | true |
| csv | Whether to output a CSV of inactive users | false |
| deploy-users | Whether to deploy users from a CSV file | false |
| deploy-users-dry-run | Whether to perform a dry run when deploying users | true |
| deploy-users-csv | CSV file location if deploying users | ./copilot-users.csv |
| deploy-validation-time | The number of days to attempt to deploy the user beyond activation date | 3 |

## ⬅️ Outputs
| Name | Description |
| --- | - |
| inactive-seats | JSON array of inactive seats |
| inactive-seat-count | The number of inactive seats |
| removed-seats | The number of seats removed |
| seat-count | The total number of seats |
| deployed-seats | JSON array of deployed seats |
| deployed-seat-count | The number of deployed seats |

## How does it work?
We're simply leveraging the [GitHub Copilot API](https://docs.github.com/en/rest/copilot). First we fetch all the Copilot seats and filter them to only inactive seats. Then if the seat is assigned directly we remove it but if it's assigned through a team we remove the user from the team. Those inactive users are reported as a CSV and a job summary table.

## Further help
To get more help on the Actions see [documentation](https://docs.github.com/en/actions).
