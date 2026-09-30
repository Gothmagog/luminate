import React, { useState } from 'react';
import { Modal, Box, TextField, Tooltip } from '@mui/material';
import { Settings } from '@mui/icons-material';
import DatabaseManager from '../../db/database-manager';
import './api-input.scss';
import '../../db/database-manager';


export function ApiInputModal() {
  const [open, setOpen] = useState(false);

  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  const handleSubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const batchSize = data.get('batch-size');
    const dimensionSize = data.get('num-dims');
    DatabaseManager.setBatchSize(batchSize as string);
    DatabaseManager.setDimensionSize(dimensionSize as string);
    handleClose();
  };

  return (
    <div>
      <Tooltip title="Settings">
        <button className="api-input-button" onClick={handleOpen}>
          <Settings style={{ color: '#aaa' }} />
        </button>
      </Tooltip>

      <Modal
        open={open}
        onClose={handleClose}
        aria-labelledby="setting-modal"
        aria-describedby="setting-modal-batch-size"
        className='api-input-modal'
      >
        <Box
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 400,
            bgcolor: 'background.paper',
            boxShadow: 24,
            p: 4,
            borderRadius: 3,
          }}
        >
          <h4>Settings</h4>
          <Box component="form" onSubmit={handleSubmit} sx={{ mt: 1 }}>
            <TextField
              variant="outlined"
              margin="normal"
              fullWidth
              id="batch-size"
              label="Generation Batch Size"
              defaultValue={DatabaseManager.getBatchSize()}
              name="batch-size"
              autoFocus
            />
            <TextField
              variant="outlined"
              margin="normal"
              fullWidth
              id="num-dims"
              label="Number of Dimensions"
              defaultValue={DatabaseManager.getDimensionSize()}
              name="num-dims"
            />
            <p className='note'>
              Luminate uses AWS Bedrock for AI generation. Authentication is handled via
              the AWS_PROFILE environment variable set before starting the dev server.
            </p>
            <button type="submit" className='submit-button'>
              Save
            </button>
          </Box>
        </Box>
      </Modal>
    </div>
  );
}
