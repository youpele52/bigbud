use super::*;

impl AgentSession {
    pub(super) fn handle_workspace_open(&mut self, request: v1::WorkspaceOpenRequest) -> v1::Frame {
        let (accepted, error_code, error_message) = if request.workspace_handle.is_empty() {
            (
                false,
                "MISSING_WORKSPACE_HANDLE".to_owned(),
                "workspace handle is required".to_owned(),
            )
        } else if !self.workspace_roots.contains_key(&request.workspace_handle)
            && self.workspace_roots.len() >= MAX_WORKSPACE_ROOTS
        {
            (
                false,
                "RESOURCE_LIMIT".to_owned(),
                "workspace root limit reached".to_owned(),
            )
        } else {
            match WorkspaceRoot::open(&request.root) {
                Ok(root) => {
                    self.workspace_roots
                        .insert(request.workspace_handle.clone(), root);
                    (true, String::new(), String::new())
                }
                Err(error) => (
                    false,
                    workspace_error_code(&error).to_owned(),
                    error.to_string(),
                ),
            }
        };
        v1::Frame {
            payload: Some(v1::frame::Payload::WorkspaceOpenResponse(
                v1::WorkspaceOpenResponse {
                    request_id: request.request_id,
                    workspace_handle: request.workspace_handle,
                    accepted,
                    error_code,
                    error_message,
                },
            )),
        }
    }

    pub(super) fn workspace(&self, handle: &str) -> Result<&WorkspaceRoot, SessionError> {
        if handle.is_empty() {
            return Err(SessionError::MissingWorkspaceHandle);
        }
        self.workspace_roots
            .get(handle)
            .ok_or_else(|| SessionError::UnknownWorkspace(handle.to_owned()))
    }

    pub(super) fn handle_read_file(
        &mut self,
        request: v1::ReadFileRequest,
    ) -> Result<v1::Frame, SessionError> {
        let operation_id = request.operation_id.clone();
        let _ = self.accept_operation(&request.operation_id, request.request_digest.clone())?;
        let result = self.workspace(&request.workspace_handle).map(|workspace| {
            workspace.read_file(
                &request.path,
                request.offset,
                usize::try_from(request.max_bytes).unwrap_or(usize::MAX),
            )
        });
        self.accepted_operations.remove(&operation_id);
        let result = result?;
        let response = match result {
            Ok(result) => v1::ReadFileResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                bytes: result.bytes,
                total_bytes: result.total_bytes,
                truncated: result.truncated,
                error_code: String::new(),
                error_message: String::new(),
            },
            Err(error) => v1::ReadFileResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                bytes: Vec::new(),
                total_bytes: 0,
                truncated: false,
                error_code: workspace_error_code(&error).to_owned(),
                error_message: error.to_string(),
            },
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::ReadFileResponse(response)),
        })
    }

    pub(super) fn handle_list_directory(
        &mut self,
        request: v1::ListDirectoryRequest,
    ) -> Result<v1::Frame, SessionError> {
        let operation_id = request.operation_id.clone();
        let _ = self.accept_operation(&request.operation_id, request.request_digest.clone())?;
        let result = self
            .workspace(&request.workspace_handle)
            .map(|workspace| workspace.list_directory(&request.path));
        self.accepted_operations.remove(&operation_id);
        let result = result?;
        let response = match result {
            Ok(entries) => v1::ListDirectoryResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                entries: entries
                    .into_iter()
                    .map(|entry| v1::DirectoryEntry {
                        path: entry.path,
                        is_directory: entry.is_directory,
                        is_file: entry.is_file,
                        size_bytes: entry.size_bytes,
                        modified_unix_ms: entry.modified_unix_ms,
                    })
                    .collect(),
                error_code: String::new(),
                error_message: String::new(),
            },
            Err(error) => v1::ListDirectoryResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                entries: Vec::new(),
                error_code: workspace_error_code(&error).to_owned(),
                error_message: error.to_string(),
            },
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::ListDirectoryResponse(response)),
        })
    }

    pub(super) fn handle_filename_search(
        &mut self,
        request: v1::FilenameSearchRequest,
    ) -> Result<v1::Frame, SessionError> {
        let operation_id = request.operation_id.clone();
        let _ = self.accept_operation(&request.operation_id, request.request_digest.clone())?;
        let result = self.workspace(&request.workspace_handle).map(|workspace| {
            workspace.search_entries(&request.path, &request.query, request.max_results as usize)
        });
        self.accepted_operations.remove(&operation_id);
        let result = result?;
        let response = match result {
            Ok(entries) => {
                let truncated = entries.len() >= request.max_results as usize;
                v1::FilenameSearchResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    terminal: true,
                    entries: entries
                        .into_iter()
                        .map(|entry| v1::DirectoryEntry {
                            path: entry.path,
                            is_directory: entry.is_directory,
                            is_file: entry.is_file,
                            size_bytes: entry.size_bytes,
                            modified_unix_ms: entry.modified_unix_ms,
                        })
                        .collect(),
                    truncated,
                    error_code: String::new(),
                    error_message: String::new(),
                }
            }
            Err(error) => v1::FilenameSearchResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                entries: Vec::new(),
                truncated: false,
                error_code: workspace_error_code(&error).to_owned(),
                error_message: error.to_string(),
            },
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::FilenameSearchResponse(response)),
        })
    }

    pub(super) fn handle_content_search(
        &mut self,
        request: v1::ContentSearchRequest,
    ) -> Result<v1::Frame, SessionError> {
        let operation_id = request.operation_id.clone();
        let _ = self.accept_operation(&request.operation_id, request.request_digest.clone())?;
        let result = self.workspace(&request.workspace_handle).map(|workspace| {
            workspace.search_content(&request.path, &request.query, request.max_results as usize)
        });
        self.accepted_operations.remove(&operation_id);
        let result = result?;
        let response = match result {
            Ok(matches) => {
                let truncated = matches.len() >= request.max_results as usize;
                v1::ContentSearchResponse {
                    request_id: request.request_id,
                    operation_id: request.operation_id,
                    terminal: true,
                    matches: matches
                        .into_iter()
                        .map(|item| v1::ContentMatch {
                            path: item.path,
                            line: item.line as u32,
                            column: item.column as u32,
                            excerpt: item.excerpt,
                        })
                        .collect(),
                    truncated,
                    error_code: String::new(),
                    error_message: String::new(),
                }
            }
            Err(error) => v1::ContentSearchResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                matches: Vec::new(),
                truncated: false,
                error_code: workspace_error_code(&error).to_owned(),
                error_message: error.to_string(),
            },
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::ContentSearchResponse(response)),
        })
    }

    pub(super) fn handle_write_file(
        &mut self,
        request: v1::WriteFileRequest,
    ) -> Result<v1::Frame, SessionError> {
        let duplicate = self.accept_operation(&request.operation_id, request.request_digest)?;
        let result = if duplicate {
            Ok(request.bytes.len() as u64)
        } else {
            self.workspace(&request.workspace_handle)?.write_file(
                &request.path,
                &request.bytes,
                (!request.expected_sha256.is_empty()).then_some(request.expected_sha256.as_str()),
            )
        };
        if result.is_err() && !duplicate {
            self.accepted_operations.remove(&request.operation_id);
        }
        let response = match result {
            Ok(written_bytes) => v1::WriteFileResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                written_bytes,
                error_code: String::new(),
                error_message: String::new(),
                current_sha256: String::new(),
            },
            Err(error) => v1::WriteFileResponse {
                request_id: request.request_id,
                operation_id: request.operation_id,
                terminal: true,
                written_bytes: 0,
                error_code: workspace_error_code(&error).to_owned(),
                error_message: error.to_string(),
                current_sha256: match error {
                    WorkspaceError::WriteConflict { actual, .. } => actual.unwrap_or_default(),
                    _ => String::new(),
                },
            },
        };
        Ok(v1::Frame {
            payload: Some(v1::frame::Payload::WriteFileResponse(response)),
        })
    }
}
