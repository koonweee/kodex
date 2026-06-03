use chrono::Utc;
use sqlx::{QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

use super::{
    bool_to_i64, row_to_project, row_to_project_preview, row_to_project_preview_route,
    row_to_project_preview_service, NewProjectPreview, NewProjectPreviewRoute,
    NewProjectPreviewService, Project, ProjectPreview, ProjectPreviewRoute,
    ProjectPreviewRouteUpdate, ProjectPreviewService, ProjectPreviewServiceUpdate,
    ProjectPreviewUpdate, Store,
};

impl Store {
    pub async fn create_project(&self, name: String, cwd: String) -> ApiResult<Project> {
        let now = Utc::now();
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            cwd,
            created_at: now,
            updated_at: now,
        };

        sqlx::query(
            "insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
        )
        .bind(&project.id)
        .bind(&project.name)
        .bind(&project.cwd)
        .bind(project.created_at)
        .bind(project.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(project)
    }

    pub async fn list_projects(&self) -> ApiResult<Vec<Project>> {
        let rows = sqlx::query(
            "select id, name, cwd, created_at, updated_at from projects order by created_at desc",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project).collect()
    }

    pub async fn get_project(&self, id: &str) -> ApiResult<Project> {
        let row =
            sqlx::query("select id, name, cwd, created_at, updated_at from projects where id = ?")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;

        row.map(row_to_project)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("project {id}")))
    }

    pub async fn create_project_preview_service(
        &self,
        service: NewProjectPreviewService,
    ) -> ApiResult<ProjectPreviewService> {
        self.get_project(&service.project_id).await?;
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_preview_services
                (id, project_id, name, protocol, local_port, health_path, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&service.project_id)
        .bind(service.name)
        .bind(service.protocol)
        .bind(service.local_port)
        .bind(service.health_path)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview_service(&service.project_id, &id)
            .await
    }

    pub async fn list_project_preview_services(
        &self,
        project_id: &str,
    ) -> ApiResult<Vec<ProjectPreviewService>> {
        self.get_project(project_id).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, name, protocol, local_port, health_path, created_at, updated_at
            from project_preview_services
            where project_id = ?
            order by created_at asc, id asc
            "#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(row_to_project_preview_service)
            .collect()
    }

    pub async fn get_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<ProjectPreviewService> {
        let row = sqlx::query(
            r#"
            select id, project_id, name, protocol, local_port, health_path, created_at, updated_at
            from project_preview_services
            where project_id = ? and id = ?
            "#,
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview_service)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("preview service {service_id}")))
    }

    pub async fn update_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
        update: ProjectPreviewServiceUpdate,
    ) -> ApiResult<ProjectPreviewService> {
        let existing = self
            .get_project_preview_service(project_id, service_id)
            .await?;
        let referenced = self
            .preview_service_reference_count(project_id, service_id)
            .await?
            > 0;
        if referenced && (update.protocol.is_some() || update.local_port.is_some()) {
            return Err(ApiError::BadRequest(
                "referenced preview services cannot change protocol or port".to_string(),
            ));
        }

        let name = update.name.unwrap_or(existing.name);
        let protocol = update.protocol.unwrap_or(existing.protocol);
        let local_port = update.local_port.unwrap_or(existing.local_port);
        let health_path = update.health_path.unwrap_or(existing.health_path);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_preview_services
            set name = ?, protocol = ?, local_port = ?, health_path = ?, updated_at = ?
            where project_id = ? and id = ?
            "#,
        )
        .bind(name)
        .bind(protocol)
        .bind(local_port)
        .bind(health_path)
        .bind(now)
        .bind(project_id)
        .bind(service_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview service {service_id}")));
        }
        self.get_project_preview_service(project_id, service_id)
            .await
    }

    pub async fn delete_project_preview_service(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview_service(project_id, service_id)
            .await?;
        if self
            .preview_service_reference_count(project_id, service_id)
            .await?
            > 0
        {
            return Err(ApiError::BadRequest(
                "preview service is referenced by a preview".to_string(),
            ));
        }
        let affected =
            sqlx::query("delete from project_preview_services where project_id = ? and id = ?")
                .bind(project_id)
                .bind(service_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview service {service_id}")));
        }
        Ok(())
    }

    pub async fn allocate_project_preview_public_port(
        &self,
        preferred_port: i64,
        start: i64,
        end: i64,
    ) -> ApiResult<i64> {
        if start > end {
            return Err(ApiError::BadRequest(
                "invalid preview port range".to_string(),
            ));
        }
        if preferred_port >= start
            && preferred_port <= end
            && !self
                .project_preview_public_port_exists(preferred_port, None)
                .await?
        {
            return Ok(preferred_port);
        }
        for port in start..=end {
            if !self.project_preview_public_port_exists(port, None).await? {
                return Ok(port);
            }
        }
        Err(ApiError::BadRequest(
            "no available preview public ports".to_string(),
        ))
    }

    pub async fn create_project_preview(
        &self,
        preview: NewProjectPreview,
    ) -> ApiResult<ProjectPreview> {
        self.get_project(&preview.project_id).await?;
        self.get_project_preview_service(&preview.project_id, &preview.root_service_id)
            .await?;
        if self
            .project_preview_public_port_exists(preview.public_port, None)
            .await?
        {
            return Err(ApiError::BadRequest(
                "preview public port is already in use".to_string(),
            ));
        }

        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_previews
                (id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&preview.project_id)
        .bind(preview.name)
        .bind(preview.public_port)
        .bind(preview.root_service_id)
        .bind(bool_to_i64(preview.enabled))
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview(&preview.project_id, &id).await
    }

    pub async fn list_project_previews(&self, project_id: &str) -> ApiResult<Vec<ProjectPreview>> {
        self.get_project(project_id).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            where project_id = ?
            order by created_at asc, id asc
            "#,
        )
        .bind(project_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview).collect()
    }

    pub async fn list_all_project_previews(&self) -> ApiResult<Vec<ProjectPreview>> {
        let rows = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            order by created_at asc, id asc
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview).collect()
    }

    pub async fn get_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
    ) -> ApiResult<ProjectPreview> {
        let row = sqlx::query(
            r#"
            select id, project_id, name, public_port, root_service_id, enabled, created_at, updated_at
            from project_previews
            where project_id = ? and id = ?
            "#,
        )
        .bind(project_id)
        .bind(preview_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("project preview {preview_id}")))
    }

    pub async fn update_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
        update: ProjectPreviewUpdate,
    ) -> ApiResult<ProjectPreview> {
        let existing = self.get_project_preview(project_id, preview_id).await?;
        let root_service_id = update.root_service_id.unwrap_or(existing.root_service_id);
        self.get_project_preview_service(project_id, &root_service_id)
            .await?;
        let public_port = update.public_port.unwrap_or(existing.public_port);
        if self
            .project_preview_public_port_exists(public_port, Some(preview_id))
            .await?
        {
            return Err(ApiError::BadRequest(
                "preview public port is already in use".to_string(),
            ));
        }
        let name = update.name.unwrap_or(existing.name);
        let enabled = update.enabled.unwrap_or(existing.enabled);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_previews
            set name = ?, public_port = ?, root_service_id = ?, enabled = ?, updated_at = ?
            where project_id = ? and id = ?
            "#,
        )
        .bind(name)
        .bind(public_port)
        .bind(root_service_id)
        .bind(bool_to_i64(enabled))
        .bind(now)
        .bind(project_id)
        .bind(preview_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("project preview {preview_id}")));
        }
        self.get_project_preview(project_id, preview_id).await
    }

    pub async fn delete_project_preview(
        &self,
        project_id: &str,
        preview_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview(project_id, preview_id).await?;
        sqlx::query("delete from project_preview_routes where preview_id = ?")
            .bind(preview_id)
            .execute(&self.pool)
            .await?;
        let affected = sqlx::query("delete from project_previews where project_id = ? and id = ?")
            .bind(project_id)
            .bind(preview_id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("project preview {preview_id}")));
        }
        Ok(())
    }

    pub async fn create_project_preview_route(
        &self,
        project_id: &str,
        route: NewProjectPreviewRoute,
    ) -> ApiResult<ProjectPreviewRoute> {
        self.get_project_preview(project_id, &route.preview_id)
            .await?;
        self.get_project_preview_service(project_id, &route.service_id)
            .await?;
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"
            insert into project_preview_routes
                (id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(&route.preview_id)
        .bind(route.path_pattern)
        .bind(route.service_id)
        .bind(bool_to_i64(route.strip_prefix))
        .bind(route.sort_order)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_project_preview_route(project_id, &route.preview_id, &id)
            .await
    }

    pub async fn list_project_preview_routes(
        &self,
        preview_id: &str,
    ) -> ApiResult<Vec<ProjectPreviewRoute>> {
        let rows = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            where preview_id = ?
            order by sort_order asc, created_at asc, id asc
            "#,
        )
        .bind(preview_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview_route).collect()
    }

    pub async fn list_all_project_preview_routes(&self) -> ApiResult<Vec<ProjectPreviewRoute>> {
        let rows = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            order by sort_order asc, created_at asc, id asc
            "#,
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_project_preview_route).collect()
    }

    pub async fn get_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
    ) -> ApiResult<ProjectPreviewRoute> {
        self.get_project_preview(project_id, preview_id).await?;
        let row = sqlx::query(
            r#"
            select id, preview_id, path_pattern, service_id, strip_prefix, sort_order, created_at, updated_at
            from project_preview_routes
            where preview_id = ? and id = ?
            "#,
        )
        .bind(preview_id)
        .bind(route_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_project_preview_route)
            .transpose()?
            .ok_or_else(|| ApiError::NotFound(format!("preview route {route_id}")))
    }

    pub async fn update_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
        update: ProjectPreviewRouteUpdate,
    ) -> ApiResult<ProjectPreviewRoute> {
        let existing = self
            .get_project_preview_route(project_id, preview_id, route_id)
            .await?;
        let service_id = update.service_id.unwrap_or(existing.service_id);
        self.get_project_preview_service(project_id, &service_id)
            .await?;
        let path_pattern = update.path_pattern.unwrap_or(existing.path_pattern);
        let strip_prefix = update.strip_prefix.unwrap_or(existing.strip_prefix);
        let sort_order = update.sort_order.unwrap_or(existing.sort_order);
        let now = Utc::now();
        let affected = sqlx::query(
            r#"
            update project_preview_routes
            set path_pattern = ?, service_id = ?, strip_prefix = ?, sort_order = ?, updated_at = ?
            where preview_id = ? and id = ?
            "#,
        )
        .bind(path_pattern)
        .bind(service_id)
        .bind(bool_to_i64(strip_prefix))
        .bind(sort_order)
        .bind(now)
        .bind(preview_id)
        .bind(route_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview route {route_id}")));
        }
        self.get_project_preview_route(project_id, preview_id, route_id)
            .await
    }

    pub async fn delete_project_preview_route(
        &self,
        project_id: &str,
        preview_id: &str,
        route_id: &str,
    ) -> ApiResult<()> {
        self.get_project_preview_route(project_id, preview_id, route_id)
            .await?;
        let affected =
            sqlx::query("delete from project_preview_routes where preview_id = ? and id = ?")
                .bind(preview_id)
                .bind(route_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if affected == 0 {
            return Err(ApiError::NotFound(format!("preview route {route_id}")));
        }
        Ok(())
    }

    pub(crate) async fn preview_service_reference_count(
        &self,
        project_id: &str,
        service_id: &str,
    ) -> ApiResult<i64> {
        let root_count: i64 = sqlx::query_scalar(
            "select count(*) from project_previews where project_id = ? and root_service_id = ?",
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_one(&self.pool)
        .await?;
        let route_count: i64 = sqlx::query_scalar(
            r#"
            select count(*)
            from project_preview_routes routes
            join project_previews previews on previews.id = routes.preview_id
            where previews.project_id = ? and routes.service_id = ?
            "#,
        )
        .bind(project_id)
        .bind(service_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(root_count + route_count)
    }

    pub(crate) async fn project_preview_public_port_exists(
        &self,
        public_port: i64,
        except_preview_id: Option<&str>,
    ) -> ApiResult<bool> {
        let mut builder = QueryBuilder::<Sqlite>::new(
            "select count(*) from project_previews where public_port = ",
        );
        builder.push_bind(public_port);
        if let Some(except_preview_id) = except_preview_id {
            builder.push(" and id <> ");
            builder.push_bind(except_preview_id);
        }
        let count: i64 = builder.build_query_scalar().fetch_one(&self.pool).await?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        error::ApiError,
        store::{
            NewProjectPreview, NewProjectPreviewRoute, NewProjectPreviewService,
            ProjectPreviewServiceUpdate, Store,
        },
    };

    #[tokio::test]
    async fn project_preview_store_enforces_ports_and_service_references() {
        let store = Store::in_memory().await.unwrap();
        let project = store
            .create_project("Kodex".to_string(), "/workspace/kodex".to_string())
            .await
            .unwrap();
        let frontend = store
            .create_project_preview_service(NewProjectPreviewService {
                project_id: project.id.clone(),
                name: "Frontend".to_string(),
                protocol: "http".to_string(),
                local_port: 3000,
                health_path: "/".to_string(),
            })
            .await
            .unwrap();
        let backend = store
            .create_project_preview_service(NewProjectPreviewService {
                project_id: project.id.clone(),
                name: "Backend".to_string(),
                protocol: "http".to_string(),
                local_port: 4000,
                health_path: "/health".to_string(),
            })
            .await
            .unwrap();

        let allocated = store
            .allocate_project_preview_public_port(13000, 10000, 19999)
            .await
            .unwrap();
        assert_eq!(allocated, 13000);
        let preview = store
            .create_project_preview(NewProjectPreview {
                project_id: project.id.clone(),
                name: "App".to_string(),
                public_port: allocated,
                root_service_id: frontend.id.clone(),
                enabled: true,
            })
            .await
            .unwrap();

        let next_allocated = store
            .allocate_project_preview_public_port(13000, 10000, 19999)
            .await
            .unwrap();
        assert_eq!(next_allocated, 10000);
        assert!(matches!(
            store
                .create_project_preview(NewProjectPreview {
                    project_id: project.id.clone(),
                    name: "Conflict".to_string(),
                    public_port: 13000,
                    root_service_id: backend.id.clone(),
                    enabled: true,
                })
                .await,
            Err(ApiError::BadRequest(_))
        ));

        let route = store
            .create_project_preview_route(
                &project.id,
                NewProjectPreviewRoute {
                    preview_id: preview.id.clone(),
                    path_pattern: "/api/*".to_string(),
                    service_id: backend.id.clone(),
                    strip_prefix: true,
                    sort_order: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(route.path_pattern, "/api/*");

        assert!(matches!(
            store
                .delete_project_preview_service(&project.id, &frontend.id)
                .await,
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            store
                .update_project_preview_service(
                    &project.id,
                    &backend.id,
                    ProjectPreviewServiceUpdate {
                        local_port: Some(4001),
                        ..ProjectPreviewServiceUpdate::default()
                    },
                )
                .await,
            Err(ApiError::BadRequest(_))
        ));
        let renamed = store
            .update_project_preview_service(
                &project.id,
                &backend.id,
                ProjectPreviewServiceUpdate {
                    name: Some("API".to_string()),
                    ..ProjectPreviewServiceUpdate::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(renamed.name, "API");

        store
            .delete_project_preview(&project.id, &preview.id)
            .await
            .unwrap();
        store
            .delete_project_preview_service(&project.id, &frontend.id)
            .await
            .unwrap();
    }
}
