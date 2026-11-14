/**
 * Authentication module for web server
 * JWT-based authentication with role-based access control
 */
use axum::{
    Json,
    extract::{FromRequestParts, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;

use crate::{config::AppConfig, web::WebState};

/// Token payload with user info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPayload {
    pub username: String,
    pub role: UserRole,
    pub iat: i64,
    pub exp: i64,
}

/// User roles
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Guest,
    Trusted,
    Admin,
}

impl Default for UserRole {
    fn default() -> Self {
        Self::Guest
    }
}

impl UserRole {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "admin" => Self::Admin,
            "trusted" => Self::Trusted,
            _ => Self::Guest,
        }
    }
}

/// JWT claims for encoding/decoding
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub role: UserRole,
    pub iat: usize,
    pub exp: usize,
}

/// Authentication errors
#[derive(Debug, Error)]
pub enum AuthError {
    #[error("Missing or invalid authorization header")]
    MissingToken,
    #[error("Invalid or expired token")]
    InvalidToken,
    #[error("Insufficient permissions")]
    InsufficientPermissions,
    #[error("JWT error: {0}")]
    JwtError(#[from] jsonwebtoken::errors::Error),
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AuthError::MissingToken => {
                (StatusCode::UNAUTHORIZED, "AUTH_REQUIRED", self.to_string())
            }
            AuthError::InvalidToken => (StatusCode::UNAUTHORIZED, "AUTH_INVALID", self.to_string()),
            AuthError::InsufficientPermissions => {
                (StatusCode::FORBIDDEN, "AUTH_FORBIDDEN", self.to_string())
            }
            AuthError::JwtError(_) => (StatusCode::UNAUTHORIZED, "AUTH_INVALID", self.to_string()),
        };

        let body = Json(serde_json::json!({
            "success": false,
            "error": message,
            "code": code,
        }));

        (status, body).into_response()
    }
}

/// Get JWT secret from config or use default
fn get_jwt_secret(config: &AppConfig) -> String {
    config
        .web
        .jwt_secret
        .clone()
        .unwrap_or_else(|| "mc-ai-bot-secret-change-in-production".to_string())
}

/// Token expiration time (24 hours)
const TOKEN_EXPIRY_HOURS: i64 = 24;

/// Generate a JWT token for a user
pub fn generate_token(config: &AppConfig, username: String, role: UserRole) -> String {
    let secret = get_jwt_secret(config);
    let now = Utc::now();
    let exp = now + Duration::hours(TOKEN_EXPIRY_HOURS);

    let claims = Claims {
        sub: username,
        role,
        iat: now.timestamp() as usize,
        exp: exp.timestamp() as usize,
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("Failed to encode JWT")
}

/// Verify a JWT token and return claims
pub fn verify_token(config: &AppConfig, token: &str) -> Result<Claims, AuthError> {
    let secret = get_jwt_secret(config);
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?;

    Ok(token_data.claims)
}

/// Extract token from request headers, cookies, or query
fn extract_token(headers: &HeaderMap, cookies: &str, query_token: Option<&str>) -> Option<String> {
    // Check Authorization header
    if let Some(auth_header) = headers.get(header::AUTHORIZATION) {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.starts_with("Bearer ") {
                return Some(auth_str[7..].to_string());
            }
        }
    }

    // Check cookie
    if !cookies.is_empty() {
        for cookie in cookies.split(';') {
            let cookie = cookie.trim();
            if cookie.starts_with("token=") {
                return Some(cookie[6..].to_string());
            }
        }
    }

    // Check query parameter
    query_token.map(|s| s.to_string())
}

/// Authentication middleware - requires valid token
pub async fn auth_middleware(
    State(state): State<Arc<RwLock<WebState>>>,
    mut request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    let config = state.read().await.config.clone();
    let headers = request.headers().clone();
    let cookies = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let query_token = request.uri().query().and_then(|q| {
        q.split('&')
            .find(|p| p.starts_with("token="))
            .map(|p| &p[6..])
    });

    let token = extract_token(&headers, cookies, query_token).ok_or(AuthError::MissingToken)?;
    let claims = verify_token(&config, &token)?;

    // Add claims to request extensions
    request.extensions_mut().insert(claims);

    Ok(next.run(request).await)
}

/// Optional authentication middleware - adds user if token is valid but doesn't require it
pub async fn optional_auth_middleware(
    State(state): State<Arc<RwLock<WebState>>>,
    mut request: Request,
    next: Next,
) -> Response {
    let config = state.read().await.config.clone();
    let headers = request.headers().clone();
    let cookies = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let query_token = request.uri().query().and_then(|q| {
        q.split('&')
            .find(|p| p.starts_with("token="))
            .map(|p| &p[6..])
    });

    if let Some(token) = extract_token(&headers, cookies, query_token) {
        if let Ok(claims) = verify_token(&config, &token) {
            request.extensions_mut().insert(claims);
        }
    }

    next.run(request).await
}

/// Role-based authorization middleware
pub fn require_role(allowed_roles: Vec<UserRole>) -> axum::middleware::Middleware<axum::Router> {
    axum::middleware::from_fn(
        move |State(state): State<Arc<RwLock<WebState>>>, mut request: Request, next: Next| {
            let allowed = allowed_roles.clone();
            async move {
                let claims = request
                    .extensions()
                    .get::<Claims>()
                    .ok_or(AuthError::MissingToken)?;

                if !allowed.contains(&claims.role) {
                    return Err(AuthError::InsufficientPermissions);
                }

                Ok(next.run(request).await)
            }
        },
    )
}

/// Admin only middleware
pub fn require_admin() -> axum::middleware::Middleware<axum::Router> {
    require_role(vec![UserRole::Admin])
}

/// Trusted or admin middleware
pub fn require_trusted() -> axum::middleware::Middleware<axum::Router> {
    require_role(vec![UserRole::Trusted, UserRole::Admin])
}

/// Extract claims from request extensions
pub fn get_claims(request: &Request) -> Option<&Claims> {
    request.extensions().get::<Claims>()
}

/// Login request payload
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Login response
#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub token: String,
    pub user: UserInfo,
    pub expires_in: String,
}

/// User info for responses
#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub username: String,
    pub role: UserRole,
}

/// Me response
#[derive(Debug, Serialize)]
pub struct MeResponse {
    pub success: bool,
    pub user: UserInfo,
}

/// Create login handler
pub async fn login_handler(
    State(config): State<Arc<AppConfig>>,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, AuthError> {
    if payload.username.is_empty() || payload.password.is_empty() {
        return Err(AuthError::MissingToken);
    }

    // Check if it's admin login
    let role = if payload.password == config.admin.password {
        UserRole::Admin
    } else {
        // For non-admin, allow any username with non-admin password as 'guest'
        UserRole::Guest
    };

    let token = generate_token(&config, payload.username.clone(), role);

    Ok(Json(LoginResponse {
        success: true,
        token,
        user: UserInfo {
            username: payload.username,
            role,
        },
        expires_in: format!("{}h", TOKEN_EXPIRY_HOURS),
    }))
}

/// Logout handler
pub async fn logout_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "success": true,
        "message": "Logged out successfully"
    }))
}

/// Get current user info
pub async fn me_handler(request: Request) -> Result<Json<MeResponse>, AuthError> {
    let claims = get_claims(&request).ok_or(AuthError::MissingToken)?;

    Ok(Json(MeResponse {
        success: true,
        user: UserInfo {
            username: claims.sub.clone(),
            role: claims.role,
        },
    }))
}

/// Socket.io authentication - extract token from handshake
pub fn extract_socket_token(
    auth: Option<&serde_json::Value>,
    query: Option<&serde_json::Value>,
) -> Option<String> {
    // Check auth object
    if let Some(auth_obj) = auth {
        if let Some(token) = auth_obj.get("token").and_then(|v| v.as_str()) {
            return Some(token.to_string());
        }
    }

    // Check query
    if let Some(query_obj) = query {
        if let Some(token) = query_obj.get("token").and_then(|v| v.as_str()) {
            return Some(token.to_string());
        }
    }

    None
}

/// Verify socket token
pub fn verify_socket_token(config: &AppConfig, token: &str) -> Result<Claims, AuthError> {
    verify_token(config, token)
}
