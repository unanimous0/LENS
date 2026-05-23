use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub app_key: String,
    pub app_secret: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Ok(Config {
            app_key:    env::var("LS_APP_KEY")   .map_err(|_| "LS_APP_KEY not set in .env")?,
            app_secret: env::var("LS_APP_SECRET").map_err(|_| "LS_APP_SECRET not set in .env")?,
            port:       env::var("PORT")
                            .unwrap_or_else(|_| "9100".into())
                            .parse()
                            .unwrap_or(9100),
        })
    }
}
