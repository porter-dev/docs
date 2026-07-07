#!/usr/bin/env bash

# Porter Azure Setup Script
# Automates the Azure cloud provider setup for Porter using federated identity credentials.

set -eo pipefail

# Colors for output
RED=$'\E[0;31m'
GREEN=$'\E[0;32m'
YELLOW=$'\E[1;33m'
BLUE=$'\E[0;34m'
NC=$'\E[0m'

# Function to print colored output
print_status() {
    echo "${BLUE}$1${NC}"
}

print_success() {
    echo "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo "${YELLOW}$1${NC}"
}

print_error() {
    echo "${RED}❌ $1${NC}"
}

print_info() {
    echo "${YELLOW}$1${NC}"
}

print_fatal() {
    print_error "$@"
    return 1
}

# Function to check prerequisites
check_prerequisites() {
    print_status "Checking prerequisites..."

    # Check if Azure CLI is installed
    if ! command -v az &> /dev/null; then
        print_fatal "Azure CLI not found. Please install it from https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
    fi

    # Check if logged in
    if ! az account show &> /dev/null; then
        print_fatal "Not logged in to Azure CLI. Please run 'az login' first"
    fi

    print_success "Prerequisites check passed"
}

# Function to get and validate subscription ID
get_subscription_id() {
    # Check if subscription ID was provided as argument
    if [ -n "$1" ]; then
        SUBSCRIPTION_ID="$1"
    else
        # Prompt user for subscription ID
        echo ""
        print_status "Available subscriptions:"
        az account list --query "[].{Name:name, SubscriptionId:id, State:state}" -o table
        echo ""
        read -rp "Enter the subscription ID you want to use: " SUBSCRIPTION_ID

        if [ -z "$SUBSCRIPTION_ID" ]; then
            print_fatal "Subscription ID is required"
        fi
    fi

    # Validate subscription ID exists and is accessible
    if ! az account show --subscription "$SUBSCRIPTION_ID" &> /dev/null; then
        print_info "Available subscriptions:"
        az account list --query "[].{Name:name, SubscriptionId:id, State:state}" -o table
        print_fatal "Subscription '$SUBSCRIPTION_ID' not found or not accessible"
    fi

    # Get subscription details for confirmation
    SUB_NAME=$(az account show --subscription "$SUBSCRIPTION_ID" --query name -o tsv)
    SUB_STATE=$(az account show --subscription "$SUBSCRIPTION_ID" --query state -o tsv)

    if [ "$SUB_STATE" != "Enabled" ]; then
        print_fatal "Subscription '$SUBSCRIPTION_ID' is not enabled (state: $SUB_STATE)"
    fi

    # Set the subscription as active
    az account set --subscription "$SUBSCRIPTION_ID"

    print_success "Using subscription: $SUB_NAME ($SUBSCRIPTION_ID)"
}

# Function to get app registration name
get_app_name() {
    if [ -n "$1" ]; then
        APP_NAME="$1"
    else
        APP_NAME="azure-porter-federated-sp"
    fi
    print_success "Using app registration name: $APP_NAME"
}

# Function to get and validate OIDC subject
get_oidc_subject() {
    # Check if OIDC subject was provided as argument
    if [ -n "$1" ]; then
        OIDC_SUBJECT="$1"
    else
        echo ""
        print_info "Copy the OIDC subject shown in Porter during the Azure cloud account connection steps."
        echo ""
        read -rp "Enter the OIDC subject (e.g. arn:aws:iam::123456789012:role/porter-azure-fic-42): " OIDC_SUBJECT

        if [ -z "$OIDC_SUBJECT" ]; then
            print_fatal "OIDC subject is required"
        fi
    fi

    if [[ ! "$OIDC_SUBJECT" =~ ^arn:aws:iam::[0-9]{12}:role/porter-azure-fic-[1-9][0-9]*$ ]]; then
        print_fatal "OIDC subject must be the per-project IAM role ARN (e.g. arn:aws:iam::123456789012:role/porter-azure-fic-42)"
    fi

    print_success "Using OIDC subject: $OIDC_SUBJECT"
}

# Function to enable resource providers
enable_resource_providers() {
    print_status "Enabling required resource providers..."

    providers=(
        "Microsoft.Capacity"
        "Microsoft.Compute"
        "Microsoft.ContainerRegistry"
        "Microsoft.ContainerService"
        "Microsoft.Insights"
        "Microsoft.ManagedIdentity"
        "Microsoft.Network"
        "Microsoft.OperationalInsights"
        "Microsoft.OperationsManagement"
        "Microsoft.ResourceGraph"
        "Microsoft.Resources"
        "Microsoft.Storage"
    )

    for provider in "${providers[@]}"; do
        echo "  Registering $provider..."
        az provider register --namespace "$provider" --wait
    done

    print_success "Resource providers enabled"
}

# Function to create or reuse the custom role for this subscription
create_custom_role() {
    ROLE_NAME="porter-aks-restricted"
    print_status "Managing custom $ROLE_NAME role..."

    local base_name="porter-aks-restricted"
    local scope="/subscriptions/${SUBSCRIPTION_ID}"

    # Reuse the base role if it already covers this subscription.
    if role_covers_subscription "$base_name" "$scope"; then
        ROLE_NAME="$base_name"
        print_success "Role $ROLE_NAME already covers this subscription, reusing it"
        return
    fi

    local sub_specific="${base_name}-${SUBSCRIPTION_ID%%-*}"
    if role_covers_subscription "$sub_specific" "$scope"; then
        ROLE_NAME="$sub_specific"
        print_success "Role $sub_specific already covers this subscription, reusing it"
        return
    fi

    # Try the base name; if it is already taken in the tenant, fall back to a subscription-specific
    # name rather than mutating the existing role (which would strip access from the subscriptions
    # it currently covers).
    if create_role_definition "$base_name" "$scope"; then
        ROLE_NAME="$base_name"
    else
        print_warning "Role name $base_name is already in use in this tenant; creating $sub_specific instead"
        create_role_definition "$sub_specific" "$scope" || exit 1
        ROLE_NAME="$sub_specific"
    fi
}

# Returns 0 if a custom role with the given name exists and is assignable to the given scope.
role_covers_subscription() {
    local name="$1" scope="$2"
    az role definition list --custom-role-only true \
        --query "[?roleName=='$name'].assignableScopes[]" -o tsv 2>/dev/null | grep -qx "$scope"
}

# Creates the porter custom role with the given name scoped to the given subscription.
create_role_definition() {
    local name="$1" scope="$2"
    print_info "Creating role $name..."

    cat > /tmp/porter-role-expected.json << EOF
{
    "assignableScopes": ["${scope}"],
    "description": "Grants Porter access to manage resources for an AKS cluster.",
    "name": "${name}",
    "permissions": [
        {
            "actions": ["*"],
            "dataActions": [],
            "notActions": [
                "Microsoft.Authorization/elevateAccess/Action",
                "Microsoft.Blueprint/blueprintAssignments/write",
                "Microsoft.Blueprint/blueprintAssignments/delete",
                "Microsoft.Compute/galleries/share/action"
            ],
            "notDataActions": []
        }
    ]
}
EOF

    local create_output
    if create_output=$(az role definition create --role-definition /tmp/porter-role-expected.json 2>&1); then
        rm -f /tmp/porter-role-expected.json
        print_success "Custom role $name created"
        return 0
    fi

    rm -f /tmp/porter-role-expected.json

    # Name collision: the role exists in the tenant but is scoped elsewhere
    if grep -q "RoleDefinitionWithSameNameExists" <<< "$create_output"; then
        return 2
    fi

    print_error "Failed to create role $name: $create_output"
    exit 1
}

create_app_registration() {
    TENANT_ID=$(az account show --query tenantId -o tsv)

    # Reuse existing app registration only on an exact display-name match
    EXISTING=$(az ad app list --display-name "$APP_NAME" -o json 2>/dev/null | jq -r --arg name "$APP_NAME" '[.[] | select(.displayName == $name)] | .[0].appId // empty')
    if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
        print_info "App registration already exists, reusing it..."
        APP_ID="$EXISTING"
        APP_OBJECT_ID=$(az ad app show --id "$APP_ID" --query id -o tsv)
        print_success "Using existing app registration (Client ID: $APP_ID)"
        return
    fi

    print_status "Creating app registration..."

    APP_OUTPUT=$(az ad app create --display-name "$APP_NAME")
    APP_ID=$(echo "$APP_OUTPUT" | jq -r '.appId')
    APP_OBJECT_ID=$(echo "$APP_OUTPUT" | jq -r '.id')

    if [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ]; then
        print_fatal "Failed to create app registration"
    fi

    az ad sp create --id "$APP_ID" > /dev/null
    sleep 10

    # The role assignment can transiently fail right after a custom role is created/updated
    # because Azure RBAC is eventually consistent; retry until it converges.
    local attempt=0
    while true; do
        attempt=$((attempt + 1))
        if az role assignment create \
            --assignee "$APP_ID" \
            --role "$ROLE_NAME" \
            --scope "/subscriptions/${SUBSCRIPTION_ID}" > /dev/null 2>&1; then
            break
        fi
        if [ "$attempt" -ge 12 ]; then
            print_fatal "Failed to assign role $ROLE_NAME after $attempt attempts"
        fi
        print_info "Role assignment not ready yet (attempt $attempt); retrying in 10s..."
        sleep 10
    done

    print_success "App registration created"
}

# Function to add API permissions
add_api_permissions() {
    print_status "Adding Microsoft Graph API permissions..."

    # Microsoft Graph App ID (constant)
    MSGRAPH_APP_ID="00000003-0000-0000-c000-000000000000"

    # Required permission names
    required_permissions=(
        "Application.ReadWrite.All"
        "Directory.ReadWrite.All"
        "Domain.Read.All"
        "Group.Create"
        "Group.ReadWrite.All"
        "RoleManagement.ReadWrite.Directory"
        "User.ReadWrite.All"
    )

    # Get Microsoft Graph service principal to fetch permission IDs dynamically
    print_info "Fetching Microsoft Graph permission IDs..."
    msgraph_sp=$(az ad sp show --id "$MSGRAPH_APP_ID" --query "appRoles[?value != null].{value:value,id:id}" -o json)

    if [ "$msgraph_sp" = "null" ] || [ -z "$msgraph_sp" ]; then
        print_fatal "Failed to fetch Microsoft Graph service principal"
    fi

    # Get existing permissions to avoid duplicates
    existing_perms=$(az ad app permission list --id "$APP_ID" --query "[?resourceAppId=='$MSGRAPH_APP_ID'].resourceAccess[].id" -o tsv 2>/dev/null || echo "")

    # Process each required permission
    for perm_name in "${required_permissions[@]}"; do
        # Get permission ID dynamically
        perm_id=$(echo "$msgraph_sp" | jq -r ".[] | select(.value == \"$perm_name\") | .id")

        if [ -z "$perm_id" ] || [ "$perm_id" = "null" ]; then
            print_warning "Permission '$perm_name' not found in Microsoft Graph API"
            continue
        fi

        # Check if permission already exists
        if echo "$existing_perms" | grep -q "$perm_id"; then
            print_info "Permission '$perm_name' already exists, skipping"
            continue
        fi

        # Add the permission
        echo "  Adding $perm_name..."
        if az ad app permission add \
            --id "$APP_ID" \
            --api "$MSGRAPH_APP_ID" \
            --api-permissions "${perm_id}=Role"; then
            print_info "Successfully added $perm_name"
        else
            print_warning "Failed to add $perm_name"
        fi
    done

    # Wait for permissions to propagate
    print_info "Waiting for permissions to propagate..."
    sleep 5

    print_success "API permissions processed"
}

# Function to grant admin consent
grant_admin_consent() {
    print_status "Granting admin consent..."

    if ! az ad app permission admin-consent --id "$APP_ID"; then
        print_error "Failed to grant admin consent. You may need admin privileges on this Azure subscription."
        print_info "You can manually grant consent in Azure Portal: App registrations > $APP_ID > API permissions > Grant admin consent"
        return 1
    fi

    print_success "Admin consent granted"
}

# Function to get and validate OIDC issuer
get_oidc_issuer() {
    if [ -n "$1" ]; then
        OIDC_ISSUER="$1"
    else
        print_fatal "--issuer is required"
    fi
    print_success "Using OIDC issuer: $OIDC_ISSUER"
}

# Wait for the federated identity credential to become active in Azure.
#
# The `az ad app federated-credential create` command returns as soon as
# the credential is persisted, but Azure's authorization service can take
# additional time to replicate it; during that window token-exchange requests
# fail with AADSTS70021 / AADSTS700211 / AADSTS700213 / AADSTS70025.
wait4_federated_credential() {
    print_status 'Waiting for the federated identity credential to become active...'

    local now exp jwt_header jwt_payload jwt
    now=$(date +%s)
    exp=$((now + 300))
    # Microsoft Entra requires the "kid" to be present so we use our own
    # since the signature/key check happens after FIC matching which is
    # what we're really testing.
    jwt_header=$(printf '{"alg":"RS256","typ":"JWT","kid":"propagation-probe"}' | base64 | tr '+/' '-_' | tr -d '=\n')
    jwt_payload=$(jq -nc \
        --arg iss "${OIDC_ISSUER}" \
        --arg sub "${OIDC_SUBJECT}" \
        --argjson iat "${now}" \
        --argjson exp "${exp}" \
        '{iss:$iss, sub:$sub, aud:"api://AzureADTokenExchange", iat:$iat, exp:$exp}' |
        base64 | tr '+/' '-_' | tr -d '=\n')
    jwt="${jwt_header}.${jwt_payload}.invalid"

    local pending='AADSTS70021|AADSTS700211|AADSTS700213|AADSTS70025'
    local response
    local success=0
    local i=0
    while ((i++ < 60)); do
        response=$(curl -sS -X POST \
            "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
            --data-urlencode "client_id=${APP_ID}" \
            --data-urlencode 'scope=https://management.azure.com/.default' \
            --data-urlencode 'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' \
            --data-urlencode "client_assertion=${jwt}" \
            --data-urlencode 'grant_type=client_credentials') || response=""
        if [[ -n ${response} ]] && echo "${response}" | jq -e . >/dev/null 2>&1 && ! grep -qE "${pending}" <<<"${response}"; then
            if ((success++ > 6)); then
                return 0 # Wait for 6 "successful" exchanges in a row
            fi
        else
            success=0 # Restart counter.
        fi
        sleep 3
        print_status '  Checking again if the federated identity credential is active...'
    done

    print_warning "Last token-exchange response: ${response}"
    return 1
}

# Function to create federated identity credential
create_federated_credential() {
    print_status "Creating federated identity credential..."

    # OIDC_SUBJECT is an IAM role ARN ending in porter-azure-fic-<projectID>.
    ROLE_NAME="${OIDC_SUBJECT##*/}"
    PROJECT_ID="${ROLE_NAME##*-}"
    FIC_NAME="porter-project-${PROJECT_ID}"

    local existing_fic existing_issuer existing_subject
    existing_fic=$(az ad app federated-credential show \
        --id "$APP_OBJECT_ID" \
        --federated-credential-id "$FIC_NAME" \
        -o json 2>/dev/null || true)

    if [ -n "$existing_fic" ]; then
        existing_issuer=$(echo "$existing_fic" | jq -r '.issuer')
        existing_subject=$(echo "$existing_fic" | jq -r '.subject')

        if [ "$existing_issuer" = "$OIDC_ISSUER" ] && [ "$existing_subject" = "$OIDC_SUBJECT" ]; then
            print_warning "Federated identity credential ${FIC_NAME} already exists with matching issuer and subject — re-probing to confirm it is active"
            # fall through to wait4_federated_credential
        else
            print_warning "Federated identity credential ${FIC_NAME} already exists but its issuer/subject do not match:"
            print_warning "  existing issuer:  ${existing_issuer}"
            print_warning "  expected issuer:  ${OIDC_ISSUER}"
            print_warning "  existing subject: ${existing_subject}"
            print_warning "  expected subject: ${OIDC_SUBJECT}"
            read -rp "Update it with the expected values? [y/N]: " UPDATE_FIC_CONFIRM
            case "$UPDATE_FIC_CONFIRM" in
                [yY]|[yY][eE][sS]) ;;
                *) print_fatal "Aborting: federated identity credential ${FIC_NAME} was left unchanged. Re-run with a different --app-name to create a separate app registration, or delete the existing credential first." ;;
            esac
            az ad app federated-credential update \
                --id "$APP_OBJECT_ID" \
                --federated-credential-id "$FIC_NAME" \
                --parameters "{
                    \"name\": \"${FIC_NAME}\",
                    \"issuer\": \"${OIDC_ISSUER}\",
                    \"subject\": \"${OIDC_SUBJECT}\",
                    \"audiences\": [\"api://AzureADTokenExchange\"]
                }" >/dev/null
            print_success "Federated identity credential updated"
        fi
    else
        az ad app federated-credential create \
            --id "$APP_OBJECT_ID" \
            --parameters "{
                \"name\": \"${FIC_NAME}\",
                \"issuer\": \"${OIDC_ISSUER}\",
                \"subject\": \"${OIDC_SUBJECT}\",
                \"audiences\": [\"api://AzureADTokenExchange\"]
            }" >/dev/null
    fi

    if wait4_federated_credential; then
        print_success "Federated identity credential is active"
    else
        print_error "$(
            printf 'Timed out waiting for the federated-credential %s to become active in Azure.\n' \
                'This is not necessarily a fatal error and you should still attempt to connect your\n' \
                'account to Porter though you may have to click the "Continue" button multiple times.' \
                "${APP_OBJECT_ID}"
        )"
    fi
}

# Function to display results
display_results() {
    echo ""
    print_success "Setup completed! Use these credentials in Porter:"
    echo ""
    echo "┌─────────────────────────────────────────────────────────────┐"
    echo "│                    AZURE CREDENTIALS                        │"
    echo "├─────────────────────────────────────────────────────────────┤"
    printf "│ Subscription ID: %-43s │\n" "$SUBSCRIPTION_ID"
    printf "│ Client ID:       %-43s │\n" "$APP_ID"
    printf "│ Tenant ID:       %-43s │\n" "$TENANT_ID"
    echo "└─────────────────────────────────────────────────────────────┘"
    echo ""

    print_info "Copy the above credentials back to the Porter dashboard to finish connecting your Azure account."
}

# Function to show usage
show_usage() {
    echo "Usage: $0 [--subject OIDC_SUBJECT] [--issuer OIDC_ISSUER] [--subscription SUBSCRIPTION_ID] [--app-name APP_NAME]"
    echo ""
    echo "  --subject        Porter OIDC subject — the per-project IAM role ARN"
    echo "                   (e.g. arn:aws:iam::123456789012:role/porter-azure-fic-42)"
    echo "                   Copy this from Porter during the Azure cloud account connection steps"
    echo "  --issuer         Porter OIDC issuer URL — AWS account-specific tokens.sts.global.api.aws URL"
    echo "                   (e.g. https://<uuid>.tokens.sts.global.api.aws)"
    echo "  --subscription   Azure subscription ID to use"
    echo "                   If not provided, you'll be prompted to select one"
    echo "  --app-name       Azure app registration name (default: azure-porter-federated-sp)"
    echo "                   Use a unique name per Porter environment to avoid collisions"
    echo ""
    echo "Examples:"
    echo "  $0 --subject arn:aws:iam::123456789012:role/porter-azure-fic-42 \\"
    echo "     --issuer https://abc-123.tokens.sts.global.api.aws"
    echo "  $0 --subject arn:aws:iam::123456789012:role/porter-azure-fic-42 \\"
    echo "     --issuer https://abc-123.tokens.sts.global.api.aws \\"
    echo "     --subscription xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    echo ""
}

# Main execution
main() {
    local arg_subscription="" arg_subject="" arg_app_name="" arg_issuer=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help) show_usage; exit 0 ;;
            --subscription) arg_subscription="$2"; shift 2 ;;
            --subject) arg_subject="$2"; shift 2 ;;
            --issuer) arg_issuer="$2"; shift 2 ;;
            --app-name) arg_app_name="$2"; shift 2 ;;
            *) print_fatal "Unknown argument: $1. Use --help for usage." ;;
        esac
    done

    echo "${GREEN}Starting Azure Workload Identity Federation setup for Porter...${NC}"
    echo ""

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        echo "  macOS: brew install jq"
        echo "  Ubuntu/Debian: sudo apt-get install jq"
        echo "  CentOS/RHEL: sudo yum install jq"
        print_fatal "jq is required but not installed. Please install jq first."
    fi

    check_prerequisites
    get_subscription_id "$arg_subscription"
    get_oidc_subject "$arg_subject"
    get_oidc_issuer "$arg_issuer"
    get_app_name "$arg_app_name"
    enable_resource_providers
    create_custom_role
    create_app_registration
    add_api_permissions

    # Try to grant admin consent, but don't fail if it doesn't work
    if ! grant_admin_consent; then
        print_warning "Admin consent failed - you may need to grant it manually in Azure Portal"
    fi

    create_federated_credential
    display_results

    echo ""
    print_success "Azure WIF setup completed successfully!"
}

# Run main function
main "$@"
